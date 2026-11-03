import { Injectable } from '@nestjs/common';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { LokasiDto } from './genta.dto';

export interface LokasiSos {
  lat: number;
  lng: number;
  akurasi_m: number | null;
  /** Waktu server saat lokasi diterima. */
  dicatat_at: string;
}

/**
 * Enkripsi koordinat SOS. AAD `log_sos:koordinat_lokasi_enc:<id_sos>` mengikat
 * ciphertext ke baris SOS-nya sehingga tidak dapat disalin ke kasus lain.
 */
@Injectable()
export class SosLokasiService {
  constructor(private readonly encryption: EncryptionService) {}

  enkripsi(idSos: string, lokasi: LokasiDto): Buffer {
    const payload: LokasiSos = {
      lat: lokasi.lat,
      lng: lokasi.lng,
      akurasi_m: lokasi.akurasi_m ?? null,
      dicatat_at: new Date().toISOString(),
    };
    return this.encryption.encrypt(JSON.stringify(payload), this.aad(idSos));
  }

  dekripsi(idSos: string, ciphertext: Buffer): LokasiSos {
    return JSON.parse(this.encryption.decrypt(ciphertext, this.aad(idSos)).toString('utf8')) as LokasiSos;
  }

  private aad(idSos: string): string {
    return `log_sos:koordinat_lokasi_enc:${idSos}`;
  }
}
