import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { REPORT_POOL } from './laporan.constants';

/** Ambang k-anonimitas: sel bernilai 1–4 disamarkan (02-backend.md §9.5). */
export const AMBANG_K = 5;
export const MAKS_RENTANG_BULAN = 36;

export const CATATAN_ANONIM =
  'Sel bernilai 1–4 disembunyikan (null) agar individu tidak dapat dikenali; grup kecil tidak '
  + 'muncul sama sekali. Total adalah jumlah sel yang ditampilkan sehingga dapat lebih kecil dari angka sebenarnya.';

/** `null` untuk 1–4; 0 dan ≥ 5 tetap ditampilkan. */
export function samarkan(n: number | string | null | undefined): number | null {
  const nilai = Number(n ?? 0);
  return nilai === 0 || nilai >= AMBANG_K ? nilai : null;
}

const jumlahkan = (nilai: (number | null)[]) => nilai.reduce<number>((total, n) => total + (n ?? 0), 0);

export interface Periode {
  dari: string;
  sampai: string;
}

interface PeriodeSql extends Periode {
  awal: string;
  akhirEksklusif: string;
}

/**
 * Laporan agregat anonim untuk Dosen Admin (PBI-20 / SCRUM-274, FR-ADM-04).
 *
 * Membaca HANYA view `v_laporan_*` melalui koneksi role `denger_report` (SELECT pada view
 * saja), sehingga modul ini secara teknis tidak dapat menyentuh data individu. View sudah
 * membuang grup < 5; service menambah lapisan kedua dengan menyamarkan setiap sel 1–4.
 * Tidak ada endpoint laporan yang menerima `id_mahasiswa`.
 */
@Injectable()
export class LaporanService {
  constructor(@Inject(REPORT_POOL) private readonly pool: Pool) {}

  async genta(dari?: string, sampai?: string) {
    const p = this.periode(dari, sampai);
    const result = await this.pool.query<{ bulan: string; total_sos: string; total_eskalasi: string }>(
      `SELECT to_char(bulan, 'YYYY-MM') AS bulan, total_sos, total_eskalasi
       FROM v_laporan_genta_bulanan WHERE bulan >= $1::date AND bulan < $2::date ORDER BY bulan`,
      [p.awal, p.akhirEksklusif],
    );
    const data = result.rows.map((row) => ({
      bulan: row.bulan,
      total_sos: samarkan(row.total_sos),
      total_eskalasi: samarkan(row.total_eskalasi),
    }));
    return {
      periode: this.label(p),
      data,
      total: { total_sos: jumlahkan(data.map((d) => d.total_sos)), total_eskalasi: jumlahkan(data.map((d) => d.total_eskalasi)) },
      catatan: CATATAN_ANONIM,
    };
  }

  async cekMandiri(dari?: string, sampai?: string) {
    const p = this.periode(dari, sampai);
    const result = await this.pool.query<{ bulan: string; risiko_phq9: string | null; risiko_gad7: string | null; jumlah: string }>(
      `SELECT to_char(bulan, 'YYYY-MM') AS bulan, risiko_phq9, risiko_gad7, jumlah
       FROM v_laporan_cek_mandiri_bulanan WHERE bulan >= $1::date AND bulan < $2::date
       ORDER BY bulan, risiko_phq9 NULLS LAST, risiko_gad7 NULLS LAST`,
      [p.awal, p.akhirEksklusif],
    );
    const data = result.rows.map((row) => ({ ...row, jumlah: samarkan(row.jumlah) }));
    const perTingkat = (kolom: 'risiko_phq9' | 'risiko_gad7') => {
      const hasil: Record<string, number> = {};
      for (const row of data) {
        const kunci = row[kolom] ?? 'TIDAK_DIISI';
        hasil[kunci] = (hasil[kunci] ?? 0) + (row.jumlah ?? 0);
      }
      return hasil;
    };
    return {
      periode: this.label(p),
      data,
      total: { pengisian: jumlahkan(data.map((d) => d.jumlah)), per_tingkat_phq9: perTingkat('risiko_phq9'), per_tingkat_gad7: perTingkat('risiko_gad7') },
      catatan: CATATAN_ANONIM,
    };
  }

  async sesi(dari?: string, sampai?: string) {
    const p = this.periode(dari, sampai);
    const result = await this.pool.query<{ bulan: string; tipe_sesi: string; status_sesi: string; jumlah: string }>(
      `SELECT to_char(bulan, 'YYYY-MM') AS bulan, tipe_sesi, status_sesi, jumlah
       FROM v_laporan_sesi_bulanan WHERE bulan >= $1::date AND bulan < $2::date
       ORDER BY bulan, tipe_sesi, status_sesi`,
      [p.awal, p.akhirEksklusif],
    );
    const data = result.rows.map((row) => ({ ...row, jumlah: samarkan(row.jumlah) }));
    const perStatus: Record<string, number> = {};
    for (const row of data) perStatus[row.status_sesi] = (perStatus[row.status_sesi] ?? 0) + (row.jumlah ?? 0);
    return {
      periode: this.label(p),
      data,
      total: { sesi: jumlahkan(data.map((d) => d.jumlah)), per_status: perStatus },
      catatan: CATATAN_ANONIM,
    };
  }

  async curhat(dari?: string, sampai?: string) {
    const p = this.periode(dari, sampai);
    const result = await this.pool.query<{ bulan: string; total_curhat: string; total_dijawab: string }>(
      `SELECT to_char(bulan, 'YYYY-MM') AS bulan, total_curhat, total_dijawab
       FROM v_laporan_curhat_bulanan WHERE bulan >= $1::date AND bulan < $2::date ORDER BY bulan`,
      [p.awal, p.akhirEksklusif],
    );
    const data = result.rows.map((row) => ({
      bulan: row.bulan,
      total_curhat: samarkan(row.total_curhat),
      total_dijawab: samarkan(row.total_dijawab),
    }));
    return {
      periode: this.label(p),
      data,
      total: { total_curhat: jumlahkan(data.map((d) => d.total_curhat)), total_dijawab: jumlahkan(data.map((d) => d.total_dijawab)) },
      catatan: CATATAN_ANONIM,
    };
  }

  /** Kondisi Circle saat ini per kategori (bukan deret waktu). */
  async circle() {
    const result = await this.pool.query<{ kategori: string; status: string; jumlah_circle: string; jumlah_anggota: string }>(
      `SELECT kategori, status, count(*) AS jumlah_circle, sum(jumlah_anggota) AS jumlah_anggota
       FROM v_laporan_circle GROUP BY kategori, status ORDER BY kategori, status`,
    );
    const data = result.rows.map((row) => ({
      kategori: row.kategori,
      status: row.status,
      jumlah_circle: Number(row.jumlah_circle),
      jumlah_anggota: samarkan(row.jumlah_anggota),
    }));
    const aktif = data.filter((d) => d.status === 'AKTIF');
    return {
      data,
      total: { circle_aktif: jumlahkan(aktif.map((d) => d.jumlah_circle)), anggota_circle_aktif: jumlahkan(aktif.map((d) => d.jumlah_anggota)) },
      catatan: CATATAN_ANONIM,
    };
  }

  /** Ringkasan semua laporan untuk dashboard admin dalam satu panggilan. */
  async ringkasan(dari?: string, sampai?: string) {
    const [genta, cekMandiri, sesi, curhat, circle] = await Promise.all([
      this.genta(dari, sampai), this.cekMandiri(dari, sampai), this.sesi(dari, sampai), this.curhat(dari, sampai), this.circle(),
    ]);
    return {
      periode: genta.periode,
      genta: genta.total,
      cek_mandiri: cekMandiri.total,
      sesi: sesi.total,
      curhat: curhat.total,
      circle: circle.total,
      catatan: CATATAN_ANONIM,
    };
  }

  // ---------------------------------------------------------------------------

  /** Rentang bulan inklusif → batas SQL `[awal, akhirEksklusif)`. */
  private periode(dari?: string, sampai?: string): PeriodeSql {
    const sekarang = new Date();
    const akhir = sampai ?? `${sekarang.getUTCFullYear()}-${String(sekarang.getUTCMonth() + 1).padStart(2, '0')}`;
    const [ty, tm] = akhir.split('-').map(Number);
    const awal = dari ?? this.geser(ty, tm, -11);
    const [ay, am] = awal.split('-').map(Number);
    const jarak = (ty - ay) * 12 + (tm - am);
    if (jarak < 0 || jarak >= MAKS_RENTANG_BULAN) {
      throw new BadRequestException({
        kode: 'PERIODE_TIDAK_VALID',
        pesan: `Periode harus 1–${MAKS_RENTANG_BULAN} bulan dan 'sampai' tidak sebelum 'dari'`,
      });
    }
    return { dari: awal, sampai: akhir, awal: `${awal}-01`, akhirEksklusif: `${this.geser(ty, tm, 1)}-01` };
  }

  private geser(tahun: number, bulan: number, delta: number): string {
    const indeks = tahun * 12 + (bulan - 1) + delta;
    return `${Math.floor(indeks / 12)}-${String((indeks % 12) + 1).padStart(2, '0')}`;
  }

  private label(p: PeriodeSql): Periode {
    return { dari: p.dari, sampai: p.sampai };
  }
}
