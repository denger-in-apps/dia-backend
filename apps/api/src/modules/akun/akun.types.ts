export interface ProfilMahasiswa {
  id: string;
  nim: string;
  nama: string;
  nama_tampilan: string | null;
  email: string;
  status_aktif: boolean;
  terakhir_verifikasi_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KontakDarurat {
  id: string;
  nama_kontak: string;
  no_telepon: string;
  hubungan: string | null;
  created_at: Date;
}

export interface EksporDataMahasiswa {
  diekspor_at: string;
  catatan: string;
  profil: ProfilMahasiswa;
  kontak_darurat: KontakDarurat[];
  preferensi_minat: { id_kategori: string; nama: string }[];
  riwayat_sos: Record<string, unknown>[];
  riwayat_cek_mandiri: Record<string, unknown>[];
  riwayat_sesi: Record<string, unknown>[];
  riwayat_curhat: Record<string, unknown>[];
  keanggotaan_circle: Record<string, unknown>[];
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}
