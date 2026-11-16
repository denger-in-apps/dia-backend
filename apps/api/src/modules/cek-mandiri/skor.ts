/** Nilai enum PostgreSQL `tingkat_risiko`, urut naik. */
export const TINGKAT_RISIKO = ['MINIMAL', 'RINGAN', 'SEDANG', 'SEDANG_BERAT', 'BERAT'] as const;
export type TingkatRisiko = (typeof TINGKAT_RISIKO)[number];

export type KodeKuesioner = 'PHQ9' | 'GAD7';

/** Jumlah butir standar; template di DB harus cocok (dicek saat dipakai). */
export const JUMLAH_BUTIR: Record<KodeKuesioner, number> = { PHQ9: 9, GAD7: 7 };
export const NILAI_MAKS_BUTIR = 3;

/**
 * Pita keparahan standar (02-backend.md §9.1):
 * PHQ-9 0–4 minimal, 5–9 ringan, 10–14 sedang, 15–19 sedang-berat, 20–27 berat.
 * GAD-7 0–4 minimal, 5–9 ringan, 10–14 sedang, 15–21 berat.
 */
export function tingkatRisiko(kode: KodeKuesioner, skor: number): TingkatRisiko {
  if (skor <= 4) return 'MINIMAL';
  if (skor <= 9) return 'RINGAN';
  if (skor <= 14) return 'SEDANG';
  if (kode === 'GAD7') return 'BERAT';
  return skor <= 19 ? 'SEDANG_BERAT' : 'BERAT';
}

export function hitungSkor(jawaban: number[]): number {
  return jawaban.reduce((total, nilai) => total + nilai, 0);
}

export type KodeRekomendasi = 'BANTUAN_SEGERA' | 'KONSELING' | 'DUKUNGAN_SEBAYA' | 'PERAWATAN_DIRI';
export type Tindakan = 'GENTA' | 'HOTLINE' | 'BOOKING_PRIORITAS' | 'BOOKING' | 'CIRCLE' | 'CEK_ULANG' | 'SUMBER_DAYA';

export interface Rekomendasi {
  kode: KodeRekomendasi;
  tindakan: Tindakan[];
  pesan: string;
}

/**
 * Rekomendasi berbasis aturan (02-backend.md §9.1). Butir 9 PHQ-9 positif (pikiran
 * menyakiti diri) selalu memicu jalur bantuan segera apa pun total skornya — praktik
 * keselamatan standar pada skrining. Bukan diagnosis.
 */
export function buatRekomendasi(tingkat: TingkatRisiko[], butir9Positif: boolean): Rekomendasi {
  const tertinggi = Math.max(-1, ...tingkat.map((t) => TINGKAT_RISIKO.indexOf(t)));
  if (butir9Positif || tertinggi >= TINGKAT_RISIKO.indexOf('BERAT')) {
    return {
      kode: 'BANTUAN_SEGERA',
      tindakan: ['GENTA', 'HOTLINE', 'BOOKING_PRIORITAS'],
      pesan: 'Hasil Anda menunjukkan Anda mungkin sedang sangat terbebani. Anda tidak sendirian — '
        + 'hubungi bantuan sekarang lewat tombol Genta atau hotline, dan jadwalkan konseling secepatnya.',
    };
  }
  if (tertinggi >= TINGKAT_RISIKO.indexOf('SEDANG')) {
    return {
      kode: 'KONSELING',
      tindakan: ['BOOKING', 'SUMBER_DAYA'],
      pesan: 'Gejala Anda berada di tingkat yang sebaiknya dibicarakan dengan psikolog. Jadwalkan sesi konseling.',
    };
  }
  if (tertinggi >= TINGKAT_RISIKO.indexOf('RINGAN')) {
    return {
      kode: 'DUKUNGAN_SEBAYA',
      tindakan: ['CIRCLE', 'CEK_ULANG', 'SUMBER_DAYA'],
      pesan: 'Ada gejala ringan. Dukungan sebaya di Circle dapat membantu; ulangi cek mandiri dalam 2 minggu.',
    };
  }
  return {
    kode: 'PERAWATAN_DIRI',
    tindakan: ['SUMBER_DAYA', 'CEK_ULANG'],
    pesan: 'Gejala Anda minimal. Tetap jaga kesehatan mental dan ulangi cek mandiri bila kondisi berubah.',
  };
}

export const DISCLAIMER =
  'Hasil cek mandiri adalah skrining, bukan diagnosis. Diskusikan hasil Anda dengan psikolog untuk penilaian yang tepat.';
