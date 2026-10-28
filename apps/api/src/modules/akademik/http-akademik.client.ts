import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AkademikClient } from './akademik.types';

@Injectable()
export class HttpAkademikClient implements AkademikClient {
  async cekStatus(nim: string): Promise<boolean> {
    const endpoint = process.env.AKADEMIK_STATUS_URL?.trim();
    const token = process.env.AKADEMIK_API_TOKEN?.trim();
    if (!endpoint || !token) {
      throw new ServiceUnavailableException('Integrasi akademik belum dikonfigurasi');
    }

    const url = new URL(endpoint);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new ServiceUnavailableException('Integrasi akademik produksi wajib memakai HTTPS');
    }
    url.searchParams.set('nim', nim);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Akademik HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || typeof (payload as { aktif?: unknown }).aktif !== 'boolean') {
        throw new Error('Format respons akademik tidak valid');
      }
      return (payload as { aktif: boolean }).aktif;
    } catch (error) {
      throw new ServiceUnavailableException('Layanan akademik tidak dapat dihubungi', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
