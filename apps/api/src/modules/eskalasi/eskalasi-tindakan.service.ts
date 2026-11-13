import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../database/database.module';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { SITUASI_SOS, SituasiSos } from '../genta/genta.constants';
import { KonfigurasiSos, KonfigurasiSosService } from './konfigurasi-sos.service';
import { SosTereskalasi } from './eskalasi.service';
import { maskNomor, SMS_PROVIDER, SmsProvider } from './sms/sms.provider';

export type JenisPenerima = 'PENERIMA_ESKALASI' | 'KONTAK_DARURAT';

interface TargetSms {
  jenis: JenisPenerima;
  id: string;
  nomor: string;
}

export interface HasilTindakan {
  /** `false` bila tindakan terhenti karena error tak terduga (mis. DB putus) dan perlu diulang. */
  selesai: boolean;
  hotline: boolean;
  sms_terkirim: number;
  sms_gagal: number;
  kontak_darurat_dilewati: string | null;
}

const MAKS_PERCOBAAN = 3;

function backoffMs(): number {
  const raw = Number(process.env.SMS_RETRY_BACKOFF_MS ?? 1000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
}

/**
 * Tindakan saat SOS tereskalasi (SCRUM-235):
 *
 * 1. **Hotline 119 ext. 8** — jalur telepon, tidak dapat menerima SMS (02-backend.md §11).
 *    SOS ditandai `eskalasi_119`, dicatat kanal `INFO_HOTLINE`, dan hotline dicantumkan di
 *    setiap SMS serta ditampilkan ke mahasiswa.
 * 2. **SMS ke penerima eskalasi kampus** — selalu.
 * 3. **SMS ke kontak darurat mahasiswa** — sesuai kebijakan anti-penyalahgunaan PBI-05:
 *    dilewati untuk SOS `perlu_verifikasi` kecuali situasi kritis, dan dibatasi
 *    `maks_eskalasi_kontak_per_hari` eskalasi per mahasiswa per 24 jam, agar SOS palsu
 *    tidak dapat dipakai untuk mengganggu keluarga.
 *
 * Isi SMS memuat nama mahasiswa (agar penerima dapat menjangkau) tetapi tidak memuat
 * situasi, koordinat, atau isi keluhan. Nomor utuh tidak pernah ditulis ke log.
 * Tidak pernah melempar error: kegagalan SMS dicatat di `log_eskalasi`; error tak terduga
 * menghasilkan `selesai: false` agar `EskalasiService` mengulang. Aman diulang: penerima
 * yang sudah TERKIRIM untuk SOS ini dilewati dan info hotline hanya dicatat sekali.
 */
@Injectable()
export class EskalasiTindakanService {
  private readonly logger = new Logger(EskalasiTindakanService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly encryption: EncryptionService,
    private readonly konfigurasi: KonfigurasiSosService,
  ) {}

  async jalankan(sos: SosTereskalasi): Promise<HasilTindakan> {
    const hasil: HasilTindakan = {
      selesai: false, hotline: false, sms_terkirim: 0, sms_gagal: 0, kontak_darurat_dilewati: null,
    };
    try {
      const config = await this.konfigurasi.ambil();
      if (config.hotline_aktif) {
        await this.catatHotline(sos.id_sos, config.hotline_label);
        hasil.hotline = true;
      }

      const [mahasiswa, penerimaKampus, kontak, sudahTerkirim] = await Promise.all([
        this.namaMahasiswa(sos.id_mahasiswa),
        this.penerimaEskalasi(),
        this.kontakDaruratDiizinkan(sos, config).then(async (izin) => {
          if (izin !== null) {
            hasil.kontak_darurat_dilewati = izin;
            return [];
          }
          return this.kontakDarurat(sos.id_mahasiswa);
        }),
        this.penerimaSudahTerkirim(sos.id_sos),
      ]);

      const hotline = config.hotline_aktif ? ` Bantuan krisis: ${config.hotline_label}.` : '';
      const ref = sos.id_sos.slice(0, 8).toUpperCase();
      const teks: Record<JenisPenerima, string> = {
        PENERIMA_ESKALASI:
          `[Denger.in] DARURAT: SOS dari ${mahasiswa} belum direspons psikolog. ` +
          `Prioritas ${sos.prioritas}. Segera tindak lanjuti. Ref ${ref}.${hotline}`,
        KONTAK_DARURAT:
          `[Denger.in] ${mahasiswa} menekan tombol darurat dan belum terhubung dengan psikolog. ` +
          `Mohon segera hubungi ${mahasiswa}.${hotline}`,
      };

      const semua = [...penerimaKampus, ...kontak];
      const target = semua.filter((t) => !sudahTerkirim.has(this.ref(t)));
      const hasilKirim = await Promise.all(
        target.map((t) => this.kirimDenganRetry(sos.id_sos, t, teks[t.jenis])),
      );
      hasil.sms_terkirim = hasilKirim.filter(Boolean).length;
      hasil.sms_gagal = hasilKirim.length - hasil.sms_terkirim;
      hasil.selesai = true;
      if (semua.length === 0) {
        this.logger.warn(`SOS ${sos.id_sos} tereskalasi tanpa penerima SMS (atur penerima eskalasi di admin)`);
      }
    } catch (error) {
      this.logger.error(`Tindakan eskalasi SOS ${sos.id_sos} gagal: ${(error as Error).message}`);
    }
    return hasil;
  }

  /** `null` bila kontak darurat boleh dikabari; selain itu alasan dilewati. */
  private async kontakDaruratDiizinkan(sos: SosTereskalasi, config: KonfigurasiSos): Promise<string | null> {
    if (!config.kontak_darurat_aktif) return 'DINONAKTIFKAN_ADMIN';
    const kritis = sos.situasi !== null && SITUASI_SOS[sos.situasi as SituasiSos]?.kritis === true;
    if (sos.perlu_verifikasi && !kritis && !config.kontak_darurat_untuk_perlu_verifikasi) {
      return 'PERLU_VERIFIKASI';
    }
    const riwayat = await this.pool.query<{ jumlah: number }>(
      `SELECT count(DISTINCT e.id_sos)::int AS jumlah
       FROM log_eskalasi e JOIN log_sos s ON s.id_sos = e.id_sos
       WHERE s.id_mahasiswa = $1 AND e.jenis_penerima = 'KONTAK_DARURAT'
         AND e.waktu_kirim > now() - interval '24 hours' AND e.id_sos <> $2`,
      [sos.id_mahasiswa, sos.id_sos],
    );
    if (riwayat.rows[0].jumlah >= config.maks_eskalasi_kontak_per_hari) return 'BATAS_HARIAN';
    return null;
  }

  /** Rujukan stabil penerima (`jenis:id`) untuk melewati yang sudah terkirim saat retry. */
  private ref(target: TargetSms): string {
    return `${target.jenis}:${target.id}`;
  }

  private async penerimaSudahTerkirim(idSos: string): Promise<Set<string>> {
    const result = await this.pool.query<{ penerima_ref: string }>(
      `SELECT penerima_ref FROM log_eskalasi
       WHERE id_sos = $1 AND kanal = 'SMS' AND status = 'TERKIRIM' AND penerima_ref IS NOT NULL`,
      [idSos],
    );
    return new Set(result.rows.map((row) => row.penerima_ref));
  }

  private async kirimDenganRetry(idSos: string, target: TargetSms, teks: string): Promise<boolean> {
    const key = `${idSos}:${target.jenis}:${target.id}`;
    for (let percobaan = 1; percobaan <= MAKS_PERCOBAAN; percobaan++) {
      try {
        const { providerMessageId } = await this.sms.kirim(target.nomor, teks, key);
        await this.catatSms(idSos, target, 'TERKIRIM', percobaan, providerMessageId, null);
        return true;
      } catch (error) {
        await this.catatSms(idSos, target, 'GAGAL', percobaan, null, (error as Error).message);
        if (percobaan < MAKS_PERCOBAAN) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs() * 3 ** (percobaan - 1)));
        }
      }
    }
    return false;
  }

  private async catatSms(
    idSos: string,
    target: TargetSms,
    status: 'TERKIRIM' | 'GAGAL',
    percobaan: number,
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO log_eskalasi
           (id_sos, kanal, jenis_penerima, penerima_masked, status, provider_message_id, percobaan_ke, error, penerima_ref)
         VALUES ($1, 'SMS', $2, $3, $4, $5, $6, $7, $8)`,
        [
          idSos, target.jenis, maskNomor(target.nomor), status, providerMessageId, percobaan,
          // Pesan error provider bisa memuat nomor; samarkan deret digit panjang.
          error ? error.replace(/\+?\d{7,}/g, (m) => maskNomor(m)).slice(0, 500) : null,
          this.ref(target),
        ],
      );
    } catch (logError) {
      this.logger.error(`Gagal mencatat log eskalasi SOS ${idSos}: ${(logError as Error).message}`);
    }
  }

  private async catatHotline(idSos: string, label: string): Promise<void> {
    await this.pool.query(`UPDATE log_sos SET eskalasi_119 = true WHERE id_sos = $1`, [idSos]);
    await this.pool.query(
      `INSERT INTO log_eskalasi (id_sos, kanal, jenis_penerima, penerima_masked, status)
       SELECT $1, 'INFO_HOTLINE', 'HOTLINE', $2, 'TERKIRIM'
       WHERE NOT EXISTS (SELECT 1 FROM log_eskalasi WHERE id_sos = $1 AND kanal = 'INFO_HOTLINE')`,
      [idSos, label.slice(0, 100)],
    );
  }

  private async namaMahasiswa(idMahasiswa: string): Promise<string> {
    const result = await this.pool.query<{ nama: string }>(
      `SELECT COALESCE(nama_tampilan, nama) AS nama FROM mahasiswa WHERE id_mahasiswa = $1`,
      [idMahasiswa],
    );
    return result.rows[0]?.nama ?? 'Mahasiswa';
  }

  private async penerimaEskalasi(): Promise<TargetSms[]> {
    const result = await this.pool.query<{ id: string; no_telepon_enc: Buffer }>(
      `SELECT id::text AS id, no_telepon_enc FROM penerima_eskalasi WHERE aktif`,
    );
    return this.dekripsiSemua(result.rows, 'PENERIMA_ESKALASI', 'penerima_eskalasi');
  }

  private async kontakDarurat(idMahasiswa: string): Promise<TargetSms[]> {
    const result = await this.pool.query<{ id: string; no_telepon_enc: Buffer }>(
      `SELECT id_kontak::text AS id, no_telepon_enc FROM kontak_darurat WHERE id_mahasiswa = $1`,
      [idMahasiswa],
    );
    return this.dekripsiSemua(result.rows, 'KONTAK_DARURAT', 'kontak_darurat');
  }

  private dekripsiSemua(
    rows: { id: string; no_telepon_enc: Buffer }[],
    jenis: JenisPenerima,
    tabel: string,
  ): TargetSms[] {
    const targets: TargetSms[] = [];
    for (const row of rows) {
      try {
        const nomor = this.encryption.decrypt(row.no_telepon_enc, `${tabel}:no_telepon_enc:${row.id}`).toString('utf8');
        targets.push({ jenis, id: row.id, nomor });
      } catch {
        this.logger.error(`Nomor ${tabel} ${row.id} tidak dapat didekripsi; dilewati`);
      }
    }
    return targets;
  }
}
