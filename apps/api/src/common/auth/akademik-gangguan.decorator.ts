import { SetMetadata } from '@nestjs/common';

export const IZINKAN_SAAT_AKADEMIK_GANGGUAN = 'auth:izinkanSaatAkademikGangguan';

/**
 * Endpoint keselamatan (Genta/SOS): mahasiswa yang tercatat AKTIF di DB tetap dilayani
 * walaupun API akademik gangguan melewati masa toleransi (02-backend.md §6: "jangan
 * memblokir mahasiswa yang sedang butuh bantuan hanya karena API akademik down").
 * Mahasiswa yang terverifikasi TIDAK aktif tetap ditolak.
 */
export const IzinkanSaatAkademikGangguan = () => SetMetadata(IZINKAN_SAAT_AKADEMIK_GANGGUAN, true);
