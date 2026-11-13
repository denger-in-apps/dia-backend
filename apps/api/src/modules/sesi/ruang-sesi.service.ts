import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, createPublicKey } from 'crypto';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { AuthenticatedUser } from '../../common/auth/auth.types';
import { StatusSesi } from '../../common/domain/sesi';

export interface PesertaSesi {
  id_sesi: string;
  id_mahasiswa: string;
  id_psikolog: string;
  status_sesi: StatusSesi;
  waktu_mulai: Date;
  waktu_selesai: Date;
}

export interface KunciPublik {
  role: 'MAHASISWA' | 'PSIKOLOG';
  /** SPKI DER base64. */
  kunci_publik: string;
  /** SHA-256 SPKI (hex, dikelompokkan) untuk verifikasi out-of-band ("safety number"). */
  sidik_jari: string;
  dibuat_at: Date;
}

export interface PesanSesi {
  id_pesan: string;
  id_sesi: string;
  pengirim: 'MAHASISWA' | 'PSIKOLOG';
  ciphertext: string;
  nonce: string;
  created_at: Date;
}

interface PesanRow {
  id_pesan: string;
  id_sesi: string;
  pengirim: 'MAHASISWA' | 'PSIKOLOG';
  ciphertext: Buffer;
  nonce: Buffer;
  created_at: Date;
}

const STATUS_BOLEH_GABUNG: StatusSesi[] = ['DIJADWALKAN', 'BERLANGSUNG'];

/**
 * Ruang sesi konseling dengan enkripsi end-to-end (PBI-11, NFR-02).
 *
 * Server hanya menyimpan **kunci publik** peserta dan **ciphertext** pesan
 * (`sesi_pesan`): kunci privat tidak pernah meninggalkan perangkat sehingga server
 * (dan admin DB) tidak dapat membaca isi chat. Kunci sesi diturunkan di klien
 * (ECDH + HKDF, lihat docs/PBI-11). Akses dibatasi ke dua peserta sesi.
 */
@Injectable()
export class RuangSesiService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /** Peserta sesi (mahasiswa pemesan atau psikolog yang dibooking); selain itu 404 agar keberadaan sesi tidak bocor. */
  async pastikanPeserta(user: AuthenticatedUser, idSesi: string): Promise<PesertaSesi> {
    if (user.role !== 'MAHASISWA' && user.role !== 'PSIKOLOG') throw this.sesiTidakDitemukan();
    const kolom = user.role === 'MAHASISWA' ? 'id_mahasiswa' : 'id_psikolog';
    const result = await this.pool.query<PesertaSesi>(
      `SELECT id_sesi::text AS id_sesi, id_mahasiswa::text AS id_mahasiswa, id_psikolog::text AS id_psikolog,
              status_sesi, waktu_mulai, waktu_selesai
       FROM sesi_konseling WHERE id_sesi = $1 AND ${kolom} = $2`,
      [idSesi, user.id],
    );
    if (!result.rows[0]) throw this.sesiTidakDitemukan();
    return result.rows[0];
  }

  /** Untuk bergabung ke room realtime: sesi harus belum berakhir. */
  async pastikanBolehGabung(user: AuthenticatedUser, idSesi: string): Promise<PesertaSesi> {
    const sesi = await this.pastikanPeserta(user, idSesi);
    if (!STATUS_BOLEH_GABUNG.includes(sesi.status_sesi)) throw this.sesiBerakhir();
    return sesi;
  }

  async simpanKunci(user: AuthenticatedUser, kunciB64: string): Promise<KunciPublik> {
    const der = this.validasiKunci(kunciB64);
    const result = await this.pool.query<{ dibuat_at: Date }>(
      `INSERT INTO kunci_e2ee (id_pengguna, role, kunci_publik) VALUES ($1, $2, $3)
       ON CONFLICT (id_pengguna, role) DO UPDATE SET kunci_publik = EXCLUDED.kunci_publik, dibuat_at = now()
       RETURNING dibuat_at`,
      [user.id, user.role, der],
    );
    return this.toKunci(user.role as KunciPublik['role'], der, result.rows[0].dibuat_at);
  }

  async kunciSaya(user: AuthenticatedUser): Promise<KunciPublik> {
    const kunci = await this.ambilKunci(user.id, user.role as KunciPublik['role']);
    if (!kunci) throw new NotFoundException({ kode: 'KUNCI_BELUM_ADA', pesan: 'Kunci publik belum diunggah' });
    return kunci;
  }

  /** Kunci publik lawan bicara di sesi ini (psikolog ↔ mahasiswa). */
  async kunciLawan(user: AuthenticatedUser, idSesi: string): Promise<KunciPublik> {
    const sesi = await this.pastikanPeserta(user, idSesi);
    const lawan = user.role === 'MAHASISWA'
      ? { id: sesi.id_psikolog, role: 'PSIKOLOG' as const }
      : { id: sesi.id_mahasiswa, role: 'MAHASISWA' as const };
    const kunci = await this.ambilKunci(lawan.id, lawan.role);
    if (!kunci) {
      throw new NotFoundException({
        kode: 'KUNCI_LAWAN_BELUM_ADA',
        pesan: 'Lawan bicara belum menyiapkan kunci enkripsi; coba lagi saat ia membuka ruang sesi',
      });
    }
    return kunci;
  }

  async daftarPesan(user: AuthenticatedUser, idSesi: string, setelah?: string, limit = 100): Promise<PesanSesi[]> {
    await this.pastikanPeserta(user, idSesi);
    const result = await this.pool.query<PesanRow>(
      `SELECT id_pesan::text AS id_pesan, id_sesi::text AS id_sesi, pengirim, ciphertext, nonce, created_at
       FROM sesi_pesan
       WHERE id_sesi = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
       ORDER BY created_at, id_pesan
       LIMIT $3`,
      [idSesi, setelah ?? null, limit],
    );
    return result.rows.map((row) => this.toPesan(row));
  }

  /** Simpan ciphertext; hanya saat sesi `BERLANGSUNG` (psikolog sudah memulai sesi). */
  async kirimPesan(user: AuthenticatedUser, idSesi: string, ciphertextB64: string, nonceB64: string): Promise<PesanSesi> {
    if (user.role !== 'MAHASISWA' && user.role !== 'PSIKOLOG') throw this.sesiTidakDitemukan();
    const ciphertext = this.decodeBase64(ciphertextB64, 'ciphertext', 16, 16 * 1024);
    const nonce = this.decodeBase64(nonceB64, 'nonce', 12, 32);
    const kolom = user.role === 'MAHASISWA' ? 'id_mahasiswa' : 'id_psikolog';
    // INSERT bersyarat: status diperiksa di statement yang sama sehingga tidak ada celah
    // antara pengecekan dan penulisan saat psikolog mengakhiri sesi.
    const result = await this.pool.query<PesanRow>(
      `INSERT INTO sesi_pesan (id_sesi, pengirim, ciphertext, nonce)
       SELECT s.id_sesi, $3::role_pengguna, $4, $5 FROM sesi_konseling s
       WHERE s.id_sesi = $1 AND s.${kolom} = $2 AND s.status_sesi = 'BERLANGSUNG'
       RETURNING id_pesan::text AS id_pesan, id_sesi::text AS id_sesi, pengirim, ciphertext, nonce, created_at`,
      [idSesi, user.id, user.role, ciphertext, nonce],
    );
    if (result.rows[0]) return this.toPesan(result.rows[0]);
    const sesi = await this.pastikanPeserta(user, idSesi);
    if (sesi.status_sesi === 'DIJADWALKAN') {
      throw new ConflictException({ kode: 'SESI_BELUM_DIMULAI', pesan: 'Sesi belum dimulai oleh psikolog' });
    }
    throw this.sesiBerakhir();
  }

  // ---------------------------------------------------------------------------

  private async ambilKunci(id: string, role: KunciPublik['role']): Promise<KunciPublik | null> {
    const result = await this.pool.query<{ kunci_publik: Buffer; dibuat_at: Date }>(
      `SELECT kunci_publik, dibuat_at FROM kunci_e2ee WHERE id_pengguna = $1 AND role = $2`,
      [id, role],
    );
    const row = result.rows[0];
    return row ? this.toKunci(role, row.kunci_publik, row.dibuat_at) : null;
  }

  /** Hanya SPKI EC P-256 atau X25519 yang diterima (pasangan dengan ECDH di WebCrypto). */
  private validasiKunci(kunciB64: string): Buffer {
    const der = this.decodeBase64(kunciB64, 'kunci_publik', 32, 1024);
    try {
      const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
      const p256 = key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
      if (p256 || key.asymmetricKeyType === 'x25519') return der;
    } catch {
      // diteruskan ke error di bawah
    }
    throw new BadRequestException({
      kode: 'KUNCI_TIDAK_VALID',
      pesan: 'kunci_publik harus SPKI DER (base64) untuk EC P-256 atau X25519',
    });
  }

  private decodeBase64(value: string, field: string, minBytes: number, maxBytes: number): Buffer {
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length < minBytes || buffer.length > maxBytes || buffer.toString('base64') !== value) {
      throw new BadRequestException({
        kode: 'PAYLOAD_TIDAK_VALID',
        pesan: `${field} harus base64 kanonis ${minBytes}–${maxBytes} byte`,
      });
    }
    return buffer;
  }

  private toKunci(role: KunciPublik['role'], der: Buffer, dibuatAt: Date): KunciPublik {
    const hex = createHash('sha256').update(der).digest('hex');
    return {
      role,
      kunci_publik: der.toString('base64'),
      sidik_jari: hex.match(/.{4}/g)!.slice(0, 16).join(' ').toUpperCase(),
      dibuat_at: dibuatAt,
    };
  }

  private toPesan(row: PesanRow): PesanSesi {
    return { ...row, ciphertext: row.ciphertext.toString('base64'), nonce: row.nonce.toString('base64') };
  }

  private sesiTidakDitemukan(): NotFoundException {
    return new NotFoundException({ kode: 'SESI_TIDAK_DITEMUKAN', pesan: 'Sesi tidak ditemukan' });
  }

  private sesiBerakhir(): ForbiddenException {
    return new ForbiddenException({ kode: 'SESI_SUDAH_BERAKHIR', pesan: 'Sesi sudah berakhir atau dibatalkan' });
  }
}
