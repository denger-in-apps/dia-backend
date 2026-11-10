/**
 * Zona waktu jadwal jaga (`jadwal_jaga.tanggal/jam_*` disimpan tanpa zona).
 * Default Asia/Jakarta (WIB); dapat diubah lewat `JADWAL_ZONA_WAKTU`.
 * Divalidasi ketat karena dikirim ke SQL sebagai parameter `AT TIME ZONE`.
 */
export function zonaWaktuJadwal(): string {
  const zona = process.env.JADWAL_ZONA_WAKTU?.trim() || 'Asia/Jakarta';
  if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(zona)) {
    throw new Error('JADWAL_ZONA_WAKTU tidak valid');
  }
  return zona;
}

/** Ekspresi SQL "psikolog sedang jaga sekarang" untuk alias tabel `j` (jadwal_jaga); `$tz` = parameter zona. */
export const sqlSedangJaga = (tz: string): string =>
  `j.tanggal = (now() AT TIME ZONE ${tz})::date
   AND (now() AT TIME ZONE ${tz})::time >= j.jam_mulai
   AND (now() AT TIME ZONE ${tz})::time < j.jam_selesai`;
