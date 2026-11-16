/** Bobot skor rekomendasi (02-backend.md §9.3; rule-based, tanpa ML). */
export const BOBOT = { minat: 3, sisaKuota: 1, aktivitas: 1 } as const;
/** Jumlah pesan 14 hari yang dianggap "aktivitas penuh" (skor aktivitas = 1). */
export const PESAN_AKTIVITAS_PENUH = 20;

export interface KandidatCircle {
  id_circle: string;
  nama_circle: string;
  nama_kategori: string;
  kuota: number;
  jumlah_anggota: number;
  pesan_14_hari: number;
  minat_cocok: boolean;
}

export interface Rekomendasi extends KandidatCircle {
  skor: number;
  sisa_kuota: number;
  alasan: string[];
}

/**
 * Skor = minat cocok (3) + proporsi sisa kuota (0–1) + aktivitas 14 hari (0–1).
 * Minat mendominasi; sisa kuota & aktivitas memecah seri dan memberi sinyal Circle
 * yang hidup tetapi belum penuh. Circle penuh tidak direkomendasikan.
 */
export function rekomendasikan(kandidat: KandidatCircle[], limit: number): Rekomendasi[] {
  return kandidat
    .filter((c) => c.jumlah_anggota < c.kuota)
    .map((c) => {
      const sisa = c.kuota - c.jumlah_anggota;
      const aktivitas = Math.min(c.pesan_14_hari / PESAN_AKTIVITAS_PENUH, 1);
      const skor = (c.minat_cocok ? BOBOT.minat : 0) + BOBOT.sisaKuota * (sisa / c.kuota) + BOBOT.aktivitas * aktivitas;
      const alasan: string[] = [];
      if (c.minat_cocok) alasan.push(`Sesuai minat Anda: ${c.nama_kategori}`);
      alasan.push(`Masih ada ${sisa} tempat`);
      if (c.pesan_14_hari > 0) alasan.push('Aktif dalam 2 minggu terakhir');
      return { ...c, skor: Math.round(skor * 1000) / 1000, sisa_kuota: sisa, alasan };
    })
    .sort((a, b) => b.skor - a.skor || a.nama_circle.localeCompare(b.nama_circle))
    .slice(0, limit);
}
