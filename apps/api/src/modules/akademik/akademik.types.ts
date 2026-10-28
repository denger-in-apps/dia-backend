export interface AkademikStatus {
  aktif: boolean;
  sumber: 'api' | 'cache';
}

export interface AkademikClient {
  cekStatus(nim: string): Promise<boolean>;
}

export const AKADEMIK_CLIENT = Symbol('AKADEMIK_CLIENT');
