import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AccessTokenService } from '../../common/auth/access-token.service';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { bearerToken } from '../../common/auth/jwt-auth.guard';
import { EVENT, NAMESPACE_PSIKOLOG, ROOM_SEMUA_PSIKOLOG, roomPsikolog } from './realtime.constants';

function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Token dari `auth.token` handshake (disarankan) atau header Authorization. Query string tidak diterima agar token tidak masuk log. */
export function tokenDariHandshake(socket: Socket): string | null {
  const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof authToken === 'string' && authToken.length > 0) {
    return authToken.replace(/^Bearer\s+/i, '');
  }
  return bearerToken(socket.handshake.headers.authorization);
}

/**
 * Gateway realtime psikolog (PBI-07, FR-PSI-03). Handshake diautentikasi dengan
 * access token yang sama dengan API HTTP; hanya role PSIKOLOG dengan akun aktif yang
 * diterima. Koneksi diputus saat access token kedaluwarsa sehingga klien wajib
 * menyambung ulang dengan token hasil refresh.
 */
@WebSocketGateway({
  namespace: NAMESPACE_PSIKOLOG,
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      callback(null, !origin || allowedOrigins().includes(origin)),
    credentials: true,
  },
})
export class PsikologGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Namespace;

  private readonly logger = new Logger(PsikologGateway.name);
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly accessToken: AccessTokenService) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.autentikasi(socket).then(
        () => next(),
        () => next(new Error('TIDAK_TERAUTENTIKASI')),
      );
    });
  }

  async handleConnection(socket: Socket): Promise<void> {
    const user = socket.data.user as AuthenticatedUser | undefined;
    const exp = socket.data.exp as number | undefined;
    if (!user || !exp) {
      socket.disconnect(true);
      return;
    }
    await socket.join([roomPsikolog(user.id), ROOM_SEMUA_PSIKOLOG]);
    const sisaMs = Math.max(0, exp * 1000 - Date.now());
    this.expiryTimers.set(socket.id, setTimeout(() => {
      socket.emit(EVENT.SESI_KEDALUWARSA, { kode: 'TOKEN_KEDALUWARSA' });
      socket.disconnect(true);
    }, sisaMs));
  }

  handleDisconnect(socket: Socket): void {
    const timer = this.expiryTimers.get(socket.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(socket.id);
  }

  /** Kirim event ke psikolog tertentu. */
  kirimKePsikolog(idPsikolog: string[], event: string, payload: unknown): void {
    if (!this.server || idPsikolog.length === 0) return;
    this.server.to(idPsikolog.map(roomPsikolog)).emit(event, payload);
  }

  /** Putuskan semua koneksi realtime seorang psikolog (mis. akun dinonaktifkan admin). */
  putuskanPsikolog(idPsikolog: string): void {
    this.server?.in(roomPsikolog(idPsikolog)).disconnectSockets(true);
  }

  /** Kirim event ke semua psikolog yang sedang terhubung. */
  kirimKeSemuaPsikolog(event: string, payload: unknown): void {
    this.server?.to(ROOM_SEMUA_PSIKOLOG).emit(event, payload);
  }

  private async autentikasi(socket: Socket): Promise<void> {
    const token = tokenDariHandshake(socket);
    if (!token) throw new Error('token kosong');
    const { user, exp } = await this.accessToken.verifikasi(token);
    if (user.role !== 'PSIKOLOG') {
      this.logger.warn(`Koneksi realtime psikolog ditolak untuk role ${user.role}`);
      throw new Error('role tidak diizinkan');
    }
    socket.data.user = user;
    socket.data.exp = exp;
  }
}
