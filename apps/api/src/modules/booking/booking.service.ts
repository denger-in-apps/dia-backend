import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { denganTransaksi } from '../../database/transaksi';
import { EncryptionService } from '../../common/crypto/encryption.service';
import {
  aadSesi,
  SQL_STATUS_SESI_AKTIF,
  SQL_STATUS_SESI_RIWAYAT,
  StatusSesi,
  TipeSesi,
} from '../../common/domain/sesi';
import { zonaWaktuJadwal } from '../../common/domain/zona-waktu';
import { PsikologGateway } from '../realtime/psikolog.gateway';
import { EVENT } from '../realtime/realtime.constants';
import { bookingConfig, JUMLAH_ALTERNATIF, RENTANG_ALTERNATIF_JAM } from './booking.constants';
import { PengingatService } from '../notifikasi/pengingat.service';
import { SesiGateway } from '../sesi/sesi.gateway';
import {
  BatalBookingDto,
  BuatBookingDto,
  CakupanBooking,
  DaftarBookingQuery,
  UbahJadwalBookingDto,
} from './booking.dto';
import { cariSlot, SlotSesi, slotSah } from './slot-sesi';

export interface PsikologTersedia {
  id: string;
  nama: string;
  /** Punya shift (dan karenanya slot) dalam horizon booking. */
  punya_jadwal: boolean;
}

export interface SesiMahasiswa {
  id_sesi: string;
  waktu_mulai: Date;
  waktu_selesai: Date;
  tipe_sesi: TipeSesi;
  status_sesi: StatusSesi;
  consent_catatan: boolean;
  alasan_batal: string | null;
  psikolog: { id: string; nama: string };
  /** Hanya terisi di detail/hasil booking (didekripsi untuk pemiliknya). */
  keluhan_awal: string | null;
  created_at: Date;
}

interface SesiRow extends Omit<SesiMahasiswa, 'psikolog' | 'keluhan_awal'> {
  id_psikolog: string;
  nama_psikolog: string;
  keluhan_awal_enc: Buffer | null;
}

export const SESI_COLUMNS = `s.id_sesi::text AS id_sesi, s.waktu_mulai, s.waktu_selesai, s.tipe_sesi, s.status_sesi,
  s.consent_catatan, s.alasan_batal, s.created_at, s.keluhan_awal_enc,
  s.id_psikolog::text AS id_psikolog, p.nama AS nama_psikolog`;

const EXCLUSION_VIOLATION = '23P01';

const FILTER_CAKUPAN: Record<CakupanBooking, { where: string; order: string }> = {
  mendatang: { where: `s.status_sesi IN ${SQL_STATUS_SESI_AKTIF}`, order: 's.waktu_mulai ASC' },
  riwayat: { where: `s.status_sesi IN ${SQL_STATUS_SESI_RIWAYAT}`, order: 's.waktu_mulai DESC' },
  semua: { where: 'true', order: 's.waktu_mulai DESC' },
};

/**
 * Booking konseling oleh mahasiswa (PBI-10, FR-MHS-05; use case Booking Konseling).
 * Anti-bentrok dua lapis (02-backend.md §8.4): validasi slot di service untuk pesan
 * error + alternatif, dan exclusion constraint DB sebagai jaminan akhir race condition.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly encryption: EncryptionService,
    private readonly gateway: PsikologGateway,
    private readonly ruangSesi: SesiGateway,
    private readonly pengingat: PengingatService,
  ) {}

  /** Psikolog yang dapat dibooking (akun AKTIF). */
  async daftarPsikolog(): Promise<PsikologTersedia[]> {
    const result = await this.pool.query<PsikologTersedia>(
      `SELECT p.id_psikolog::text AS id, p.nama,
              EXISTS (
                SELECT 1 FROM jadwal_jaga j
                WHERE j.id_psikolog = p.id_psikolog
                  AND j.tanggal BETWEEN (now() AT TIME ZONE $1::text)::date
                                    AND (now() AT TIME ZONE $1::text)::date + $2::int
              ) AS punya_jadwal
       FROM psikolog p WHERE p.status_akun = 'AKTIF'
       ORDER BY p.nama`,
      [zonaWaktuJadwal(), bookingConfig.horizonHari()],
    );
    return result.rows;
  }

  /** Slot kosong psikolog pada satu tanggal lokal (tidak termasuk yang bentrok dengan sesi mahasiswa ini). */
  async slot(idMahasiswa: string, idPsikolog: string, tanggal: string): Promise<SlotSesi[]> {
    this.validasiTanggal(tanggal);
    await this.pastikanPsikologAktif(idPsikolog);
    return cariSlot(this.pool, { idPsikolog, tanggal, idMahasiswa, limit: 200 });
  }

  async buat(idMahasiswa: string, dto: BuatBookingDto): Promise<SesiMahasiswa> {
    const waktuMulai = this.parseWaktu(dto.waktu_mulai);
    await this.pastikanPsikologAktif(dto.id_psikolog);
    if (!(await slotSah(this.pool, dto.id_psikolog, waktuMulai))) throw this.slotTidakValid();

    const idSesi = randomUUID();
    const keluhan = this.encryption.encrypt(dto.keluhan_awal, aadSesi('keluhan_awal_enc', idSesi));
    let row: SesiRow;
    try {
      row = await denganTransaksi(this.pool, async (client) => {
        // Kunci baris mahasiswa: batas sesi aktif tidak boleh terlewati oleh request paralel.
        await this.lockMahasiswa(client, idMahasiswa);
        await this.cekBatasSesiAktif(client, idMahasiswa);
        const inserted = await client.query<{ id_sesi: string }>(
          `INSERT INTO sesi_konseling
             (id_sesi, waktu_mulai, waktu_selesai, tipe_sesi, keluhan_awal_enc, id_mahasiswa, id_psikolog)
           VALUES ($1, $2::timestamptz, $2::timestamptz + make_interval(mins => $3::int), $4, $5, $6, $7)
           RETURNING id_sesi::text AS id_sesi`,
          [idSesi, waktuMulai.toISOString(), bookingConfig.durasiMenit(), dto.tipe_sesi, keluhan,
            idMahasiswa, dto.id_psikolog],
        );
        const sesi = await this.ambilRow(client, idMahasiswa, inserted.rows[0].id_sesi);
        await this.simpanNotifikasiPsikolog(client, sesi, 'SESI_BARU');
        await this.setelahJadwalBerubah(client, sesi);
        return sesi;
      });
    } catch (error) {
      throw await this.terjemahkanBentrok(error, idMahasiswa, dto.id_psikolog, waktuMulai);
    }

    this.siarkanKePsikolog(row, EVENT.BOOKING_BARU);
    return this.toDto(row, dto.keluhan_awal);
  }

  async daftar(idMahasiswa: string, query: DaftarBookingQuery): Promise<SesiMahasiswa[]> {
    const { where, order } = FILTER_CAKUPAN[query.cakupan ?? 'mendatang'];
    const result = await this.pool.query<SesiRow>(
      `SELECT ${SESI_COLUMNS}
       FROM sesi_konseling s JOIN psikolog p ON p.id_psikolog = s.id_psikolog
       WHERE s.id_mahasiswa = $1 AND ${where}
       ORDER BY ${order}
       LIMIT $2`,
      [idMahasiswa, query.limit ?? 50],
    );
    return result.rows.map((row) => this.toDto(row, null));
  }

  async detail(idMahasiswa: string, idSesi: string): Promise<SesiMahasiswa> {
    const row = await this.ambilRow(this.pool, idMahasiswa, idSesi);
    return this.toDto(row, this.dekripsiKeluhan(row));
  }

  /**
   * Ubah jadwal sesi milik sendiri ke slot lain psikolog yang sama (PBI-12; use case
   * Booking alt 5.a/5.b). Hanya sesi `DIJADWALKAN` dan paling lambat
   * `BOOKING_MIN_SEBELUM_MENIT` sebelum jadwal lama. Bentrok → 409 + alternatif.
   */
  async ubahJadwal(idMahasiswa: string, idSesi: string, dto: UbahJadwalBookingDto): Promise<SesiMahasiswa> {
    const waktuBaru = this.parseWaktu(dto.waktu_mulai);
    const awal = await this.ambilRow(this.pool, idMahasiswa, idSesi);
    this.pastikanBisaDiubah(awal, 'ubah');
    const tipeBaru = dto.tipe_sesi ?? awal.tipe_sesi;
    if (new Date(awal.waktu_mulai).getTime() === waktuBaru.getTime() && tipeBaru === awal.tipe_sesi) {
      return this.toDto(awal, null); // tidak ada perubahan (idempoten)
    }
    if (!(await slotSah(this.pool, awal.id_psikolog, waktuBaru))) throw this.slotTidakValid();

    let hasil: { sebelum: SesiRow; sesudah: SesiRow };
    try {
      hasil = await denganTransaksi(this.pool, async (client) => {
        // Kunci & periksa ulang di dalam transaksi: status/jadwal bisa berubah sejak pembacaan awal.
        const sebelum = await this.ambilRow(client, idMahasiswa, idSesi, true);
        this.pastikanBisaDiubah(sebelum, 'ubah');
        await client.query(
          `UPDATE sesi_konseling
           SET waktu_mulai = $2::timestamptz, waktu_selesai = $2::timestamptz + make_interval(mins => $3::int),
               tipe_sesi = $4
           WHERE id_sesi = $1`,
          [idSesi, waktuBaru.toISOString(), bookingConfig.durasiMenit(), tipeBaru],
        );
        const sesudah = await this.ambilRow(client, idMahasiswa, idSesi);
        await this.simpanNotifikasiPsikolog(client, sesudah, 'SESI_DIUBAH', {
          waktu_mulai_lama: new Date(sebelum.waktu_mulai).toISOString(),
        });
        await this.setelahJadwalBerubah(client, sesudah);
        return { sebelum, sesudah };
      });
    } catch (error) {
      throw await this.terjemahkanBentrok(error, idMahasiswa, awal.id_psikolog, waktuBaru, idSesi);
    }

    this.siarkanKePsikolog(hasil.sesudah, EVENT.BOOKING_DIUBAH, {
      waktu_mulai_lama: new Date(hasil.sebelum.waktu_mulai).toISOString(),
    });
    return this.toDto(hasil.sesudah, null);
  }

  /** Batalkan sesi milik sendiri sebelum dimulai (PBI-12; use case Booking alt 5.c). */
  async batal(idMahasiswa: string, idSesi: string, dto: BatalBookingDto): Promise<SesiMahasiswa> {
    const sesi = await denganTransaksi(this.pool, async (client) => {
      const sebelum = await this.ambilRow(client, idMahasiswa, idSesi, true);
      this.pastikanBisaDiubah(sebelum, 'batal');
      await client.query(
        `UPDATE sesi_konseling SET status_sesi = 'DIBATALKAN', alasan_batal = $2 WHERE id_sesi = $1`,
        [idSesi, dto.alasan ?? 'Dibatalkan mahasiswa'],
      );
      const sesudah = await this.ambilRow(client, idMahasiswa, idSesi);
      // Alasan pembatalan tidak dimasukkan ke notifikasi; psikolog melihatnya di detail sesi.
      await this.simpanNotifikasiPsikolog(client, sesudah, 'SESI_DIBATALKAN');
      await this.setelahJadwalBerubah(client, sesudah);
      return sesudah;
    });

    this.siarkanKePsikolog(sesi, EVENT.BOOKING_DIBATALKAN);
    this.ruangSesi.siarkanStatus(sesi.id_sesi, { id_sesi: sesi.id_sesi, status_sesi: sesi.status_sesi });
    return this.toDto(sesi, null);
  }

  // ---------------------------------------------------------------------------

  /**
   * Setelah sesi dibuat/diubah/dibatalkan, di dalam transaksi yang sama: atur ulang
   * pengingat (PBI-14) sehingga tidak pernah ada pengingat untuk jadwal lama/sesi batal.
   */
  protected async setelahJadwalBerubah(client: PoolClient, sesi: SesiRow): Promise<void> {
    await this.pengingat.jadwalkan(client, sesi);
  }

  /** Sesi hanya dapat diubah/dibatalkan selama `DIJADWALKAN` dan belum melewati batas waktunya. */
  protected pastikanBisaDiubah(sesi: SesiRow, aksi: 'ubah' | 'batal'): void {
    if (sesi.status_sesi !== 'DIJADWALKAN') {
      throw new ConflictException({
        kode: sesi.status_sesi === 'DIBATALKAN' ? 'SESI_SUDAH_DIBATALKAN' : 'SESI_TIDAK_DAPAT_DIUBAH',
        pesan: `Sesi berstatus ${sesi.status_sesi} tidak dapat di${aksi === 'ubah' ? 'ubah' : 'batalkan'}`,
      });
    }
    const mulai = new Date(sesi.waktu_mulai).getTime();
    const batasMs = aksi === 'ubah' ? bookingConfig.minimalSebelumMenit() * 60_000 : 0;
    if (Date.now() > mulai - batasMs) {
      throw new UnprocessableEntityException({
        kode: 'BATAS_WAKTU_TERLEWATI',
        pesan: aksi === 'ubah'
          ? `Jadwal hanya dapat diubah paling lambat ${bookingConfig.minimalSebelumMenit()} menit sebelum sesi`
          : 'Sesi yang sudah dimulai tidak dapat dibatalkan',
      });
    }
  }

  protected async ambilRow(executor: Pool | PoolClient, idMahasiswa: string, idSesi: string, lock = false): Promise<SesiRow> {
    const result = await executor.query<SesiRow>(
      `SELECT ${SESI_COLUMNS}
       FROM sesi_konseling s JOIN psikolog p ON p.id_psikolog = s.id_psikolog
       WHERE s.id_sesi = $1 AND s.id_mahasiswa = $2 ${lock ? 'FOR UPDATE OF s' : ''}`,
      [idSesi, idMahasiswa],
    );
    if (!result.rows[0]) throw new NotFoundException({ kode: 'SESI_TIDAK_DITEMUKAN', pesan: 'Sesi tidak ditemukan' });
    return result.rows[0];
  }

  /**
   * SQLSTATE 23P01 dari exclusion constraint → 409 beserta slot alternatif
   * (use case alt 5.b): 3–5 slot terdekat psikolog yang sama; bila kosong,
   * psikolog lain di sekitar waktu yang diminta.
   */
  protected async terjemahkanBentrok(
    error: unknown,
    idMahasiswa: string,
    idPsikolog: string,
    waktuMulai: Date,
    kecualiSesi?: string,
  ): Promise<unknown> {
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code !== EXCLUSION_VIOLATION) return error;
    if (pgError.constraint === 'sesi_tidak_bentrok_mahasiswa') {
      return new ConflictException({
        kode: 'SESI_BENTROK_MAHASISWA',
        pesan: 'Anda sudah memiliki sesi lain pada waktu tersebut',
      });
    }
    const alternatif = await this.alternatif(idMahasiswa, idPsikolog, waktuMulai, kecualiSesi).catch((altError) => {
      this.logger.warn(`Gagal mencari slot alternatif: ${(altError as Error).message}`);
      return [];
    });
    return new ConflictException({
      kode: 'SESI_BENTROK',
      pesan: 'Slot sudah dipesan, silakan pilih slot lain',
      detail: { alternatif },
    });
  }

  protected async alternatif(
    idMahasiswa: string,
    idPsikolog: string,
    waktuMulai: Date,
    kecualiSesi?: string,
  ): Promise<SlotSesi[]> {
    const awalHari = new Date(Math.max(Date.now(), waktuMulai.getTime() - 12 * 3_600_000));
    const samaPsikolog = await cariSlot(this.pool, {
      idPsikolog, idMahasiswa, kecualiSesi, dari: awalHari, limit: JUMLAH_ALTERNATIF,
    });
    if (samaPsikolog.length > 0) return samaPsikolog;
    const rentang = RENTANG_ALTERNATIF_JAM * 3_600_000;
    return cariSlot(this.pool, {
      idMahasiswa,
      kecualiSesi,
      dari: new Date(waktuMulai.getTime() - rentang),
      sampai: new Date(waktuMulai.getTime() + rentang),
      limit: JUMLAH_ALTERNATIF,
    });
  }

  protected async cekBatasSesiAktif(client: PoolClient, idMahasiswa: string): Promise<void> {
    const maks = bookingConfig.maksSesiAktif();
    const count = await client.query<{ jumlah: number }>(
      `SELECT count(*)::int AS jumlah FROM sesi_konseling
       WHERE id_mahasiswa = $1 AND status_sesi IN ${SQL_STATUS_SESI_AKTIF} AND waktu_selesai > now()`,
      [idMahasiswa],
    );
    if (count.rows[0].jumlah >= maks) {
      throw new UnprocessableEntityException({
        kode: 'BATAS_SESI_AKTIF',
        pesan: `Maksimal ${maks} sesi mendatang; selesaikan atau batalkan sesi lain terlebih dahulu`,
      });
    }
  }

  protected async lockMahasiswa(client: PoolClient, idMahasiswa: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM mahasiswa WHERE id_mahasiswa = $1 AND deleted_at IS NULL FOR UPDATE`,
      [idMahasiswa],
    );
    if (!result.rowCount) throw new NotFoundException({ kode: 'AKUN_TIDAK_DITEMUKAN', pesan: 'Akun tidak ditemukan' });
  }

  protected async pastikanPsikologAktif(idPsikolog: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM psikolog WHERE id_psikolog = $1 AND status_akun = 'AKTIF'`,
      [idPsikolog],
    );
    if (!result.rowCount) {
      throw new NotFoundException({ kode: 'PSIKOLOG_TIDAK_DITEMUKAN', pesan: 'Psikolog tidak ditemukan atau tidak aktif' });
    }
  }

  /** Notifikasi in-app untuk psikolog; isi keluhan tidak pernah disertakan. */
  protected async simpanNotifikasiPsikolog(
    executor: Pool | PoolClient,
    sesi: SesiRow,
    jenis: 'SESI_BARU' | 'SESI_DIUBAH' | 'SESI_DIBATALKAN',
    tambahan: Record<string, unknown> = {},
  ): Promise<void> {
    await executor.query(
      `INSERT INTO notifikasi (id_penerima, role, jenis, payload) VALUES ($1, 'PSIKOLOG', $2, $3::jsonb)`,
      [sesi.id_psikolog, jenis, JSON.stringify({ ...this.payloadRealtime(sesi), ...tambahan })],
    );
  }

  /** Realtime ke psikolog (best effort; notifikasi in-app sudah tersimpan sebagai cadangan). */
  protected siarkanKePsikolog(sesi: SesiRow, event: string, tambahan: Record<string, unknown> = {}): void {
    try {
      this.gateway.kirimKePsikolog([sesi.id_psikolog], event, { ...this.payloadRealtime(sesi), ...tambahan });
    } catch (error) {
      this.logger.warn(`Gagal menyiarkan ${event} sesi ${sesi.id_sesi}: ${(error as Error).message}`);
    }
  }

  protected payloadRealtime(sesi: SesiRow) {
    return {
      id_sesi: sesi.id_sesi,
      waktu_mulai: new Date(sesi.waktu_mulai).toISOString(),
      waktu_selesai: new Date(sesi.waktu_selesai).toISOString(),
      tipe_sesi: sesi.tipe_sesi,
      status_sesi: sesi.status_sesi,
    };
  }

  protected toDto(row: SesiRow, keluhan: string | null): SesiMahasiswa {
    const { id_psikolog, nama_psikolog, keluhan_awal_enc: _enc, ...rest } = row;
    return { ...rest, psikolog: { id: id_psikolog, nama: nama_psikolog }, keluhan_awal: keluhan };
  }

  protected dekripsiKeluhan(row: SesiRow): string | null {
    if (!row.keluhan_awal_enc) return null;
    return this.encryption.decrypt(row.keluhan_awal_enc, aadSesi('keluhan_awal_enc', row.id_sesi)).toString('utf8');
  }

  protected parseWaktu(value: string): Date {
    const waktu = new Date(value);
    if (Number.isNaN(waktu.getTime())) {
      throw new BadRequestException({ kode: 'WAKTU_TIDAK_VALID', pesan: 'waktu_mulai tidak valid' });
    }
    return waktu;
  }

  protected slotTidakValid(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      kode: 'SLOT_TIDAK_VALID',
      pesan: 'Waktu tidak sesuai slot jadwal psikolog, terlalu dekat, atau di luar rentang booking',
    });
  }

  private validasiTanggal(tanggal: string): void {
    const date = new Date(`${tanggal}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== tanggal) {
      throw new BadRequestException({ kode: 'TANGGAL_TIDAK_VALID', pesan: 'Tanggal tidak valid' });
    }
  }
}
