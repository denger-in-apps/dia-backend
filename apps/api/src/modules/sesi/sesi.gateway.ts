import { HttpException, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import { Namespace, Socket } from 'socket.io';
import { AccessTokenService } from '../../common/auth/access-token.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { allowedOrigins, tokenDariHandshake } from '../realtime/psikolog.gateway';
import { RuangSesiService } from './ruang-sesi.service';
import { EVENT_SESI, MAKS_SINYAL_RTC, NAMESPACE_SESI, roomSesi, sesiConfig } from './sesi.constants';

export interface Ack<T = unknown> {
  ok: boolean;
  kode?: string;
  pesan?: string;
  data?: T;
}

/**
 * Ruang sesi realtime (PBI-11): chat E2EE dan signaling WebRTC antara mahasiswa dan
 * psikolog sesi. Server hanya meneruskan/menyimpan ciphertext; setiap event diperiksa
 * ulang keanggotaannya (bukan hanya saat bergabung) agar sesi yang berakhir langsung tertutup.
 */
@WebSocketGateway({
  namespace: NAMESPACE_SESI,
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      callback(null, !origin || allowedOrigins().includes(origin)),
    credentials: true,
  },
  maxHttpBufferSize: 64 * 1024,
})
export class SesiGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Namespace;

  private readonly logger = new Logger(SesiGateway.name);
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly kuota = new Map<string, { mulai: number; jumlah: number }>();

  constructor(
    private readonly accessToken: AccessTokenService,
    private readonly ruang: RuangSesiService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.autentikasi(socket).then(
        () => next(),
        () => next(new Error('TIDAK_TERAUTENTIKASI')),
      );
    });
  }

  handleConnection(socket: Socket): void {
    const exp = socket.data.exp as number | undefined;
    if (!socket.data.user || !exp) {
      socket.disconnect(true);
      return;
    }
    this.expiryTimers.set(socket.id, setTimeout(() => {
      socket.emit(EVENT_SESI.TOKEN_KEDALUWARSA, { kode: 'TOKEN_KEDALUWARSA' });
      socket.disconnect(true);
    }, Math.max(0, exp * 1000 - Date.now())));
  }

  handleDisconnect(socket: Socket): void {
    const timer = this.expiryTimers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(socket.id);
    this.kuota.delete(socket.id);
  }

  @SubscribeMessage(EVENT_SESI.GABUNG)
  async gabung(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    return this.tangani(async () => {
      const idSesi = this.idSesi(body);
      await this.ruang.pastikanBolehGabung(this.user(socket), idSesi);
      await socket.join(roomSesi(idSesi));
      return undefined;
    });
  }

  @SubscribeMessage(EVENT_SESI.KIRIM_PESAN)
  async kirimPesan(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    return this.tangani(async () => {
      const idSesi = this.idSesi(body);
      this.cekKuota(socket);
      const { ciphertext, nonce } = (body ?? {}) as { ciphertext?: unknown; nonce?: unknown };
      if (typeof ciphertext !== 'string' || typeof nonce !== 'string') {
        throw new HttpException({ kode: 'PAYLOAD_TIDAK_VALID', pesan: 'ciphertext dan nonce wajib (base64)' }, 400);
      }
      const pesan = await this.ruang.kirimPesan(this.user(socket), idSesi, ciphertext, nonce);
      this.siarkanPesan(pesan.id_sesi, pesan);
      return pesan;
    });
  }

  /** Relay signaling WebRTC ke peserta lain di room; hanya untuk anggota room sesi yang masih berjalan. */
  @SubscribeMessage(EVENT_SESI.SINYAL_RTC)
  async sinyal(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    return this.tangani(async () => {
      const idSesi = this.idSesi(body);
      this.cekKuota(socket);
      const data = (body as { data?: unknown }).data;
      if (data === undefined || JSON.stringify(data).length > MAKS_SINYAL_RTC) {
        throw new HttpException({ kode: 'PAYLOAD_TIDAK_VALID', pesan: 'data sinyal kosong atau terlalu besar' }, 400);
      }
      if (!socket.rooms.has(roomSesi(idSesi))) {
        throw new HttpException({ kode: 'BELUM_BERGABUNG', pesan: 'Gabung ke sesi terlebih dahulu' }, 403);
      }
      const sesi = await this.ruang.pastikanBolehGabung(this.user(socket), idSesi);
      if (sesi.status_sesi !== 'BERLANGSUNG') {
        throw new HttpException({ kode: 'SESI_BELUM_DIMULAI', pesan: 'Sesi belum dimulai oleh psikolog' }, 409);
      }
      socket.to(roomSesi(idSesi)).emit(EVENT_SESI.SINYAL_RTC, {
        id_sesi: idSesi, dari: this.user(socket).role, data,
      });
      return undefined;
    });
  }

  /** Dipanggil controller REST setelah pesan tersimpan lewat HTTP (fallback tanpa socket). */
  siarkanPesan(idSesi: string, pesan: unknown): void {
    this.server?.to(roomSesi(idSesi)).emit(EVENT_SESI.PESAN_BARU, pesan);
  }

  /** Status sesi berubah; sesi yang berakhir menutup room sehingga tidak ada lagi relay. */
  siarkanStatus(idSesi: string, payload: { id_sesi: string; status_sesi: string }): void {
    if (!this.server) return;
    this.server.to(roomSesi(idSesi)).emit(EVENT_SESI.STATUS, payload);
    if (!['DIJADWALKAN', 'BERLANGSUNG'].includes(payload.status_sesi)) {
      this.server.in(roomSesi(idSesi)).socketsLeave(roomSesi(idSesi));
    }
  }

  // ---------------------------------------------------------------------------

  private async autentikasi(socket: Socket): Promise<void> {
    const token = tokenDariHandshake(socket);
    if (!token) throw new Error('token kosong');
    const { user, exp } = await this.accessToken.verifikasi(token);
    if (user.role !== 'MAHASISWA' && user.role !== 'PSIKOLOG') {
      this.logger.warn(`Koneksi ruang sesi ditolak untuk role ${user.role}`);
      throw new Error('role tidak diizinkan');
    }
    socket.data.user = user;
    socket.data.exp = exp;
  }

  private async tangani<T>(work: () => Promise<T>): Promise<Ack<T>> {
    try {
      const data = await work();
      return data === undefined ? { ok: true } : { ok: true, data };
    } catch (error) {
      if (error instanceof HttpException) {
        const response = error.getResponse() as { kode?: string; pesan?: string } | string;
        return typeof response === 'string'
          ? { ok: false, kode: 'GAGAL', pesan: response }
          : { ok: false, kode: response.kode ?? 'GAGAL', pesan: response.pesan };
      }
      this.logger.error(`Event ruang sesi gagal: ${(error as Error).message}`);
      return { ok: false, kode: 'KESALAHAN_SERVER', pesan: 'Terjadi kesalahan, coba lagi' };
    }
  }

  private user(socket: Socket): AuthenticatedUser {
    return socket.data.user as AuthenticatedUser;
  }

  private idSesi(body: unknown): string {
    const idSesi = (body as { id_sesi?: unknown } | null)?.id_sesi;
    if (typeof idSesi !== 'string' || !isUUID(idSesi)) {
      throw new HttpException({ kode: 'PAYLOAD_TIDAK_VALID', pesan: 'id_sesi tidak valid' }, 400);
    }
    return idSesi;
  }

  private cekKuota(socket: Socket): void {
    const now = Date.now();
    const current = this.kuota.get(socket.id);
    if (!current || now - current.mulai >= 10_000) {
      this.kuota.set(socket.id, { mulai: now, jumlah: 1 });
      return;
    }
    current.jumlah++;
    if (current.jumlah > sesiConfig.maksPesanPer10Detik()) {
      throw new HttpException({ kode: 'TERLALU_CEPAT', pesan: 'Terlalu banyak pesan, tunggu sebentar' }, 429);
    }
  }
}
