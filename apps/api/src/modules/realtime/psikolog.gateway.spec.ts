import { ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AccessTokenService } from '../../common/auth/access-token.service';
import { PsikologGateway } from './psikolog.gateway';
import { EVENT } from './realtime.constants';

describe('PsikologGateway (Socket.IO)', () => {
  const PSI_A = '22222222-2222-4222-8222-222222222222';
  const PSI_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
  const MHS = '11111111-1111-4111-8111-111111111111';
  let app: INestApplication;
  let gateway: PsikologGateway;
  let url: string;
  let verifikasi: jest.Mock;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const exp = () => Math.floor(Date.now() / 1000) + 900;
    let revokeCalls = 0;
    let resetCalls = 0;
    verifikasi = jest.fn(async (token: string) => {
      // Aktif saat handshake, lalu dinonaktifkan admin (pemeriksaan berikutnya ditolak).
      if (token === 'psi-revoke') {
        revokeCalls++;
        if (revokeCalls === 1) return { user: { id: PSI_A, role: 'PSIKOLOG' }, exp: exp() };
        throw new ForbiddenException('AKUN_TIDAK_AKTIF');
      }
      // Password di-reset admin setelah tersambung: verifikasi berikutnya menolak (kontrak tim).
      if (token === 'psi-reset') {
        resetCalls++;
        if (resetCalls === 1) return { user: { id: PSI_A, role: 'PSIKOLOG' }, exp: exp() };
        throw new ForbiddenException({ kode: 'PASSWORD_WAJIB_DIGANTI', pesan: 'Ganti password sementara terlebih dahulu' });
      }
      if (token === 'psi-a') return { user: { id: PSI_A, role: 'PSIKOLOG' }, exp: exp() };
      if (token === 'psi-b') return { user: { id: PSI_B, role: 'PSIKOLOG' }, exp: exp() };
      if (token === 'psi-short') return { user: { id: PSI_A, role: 'PSIKOLOG' }, exp: Math.floor(Date.now() / 1000) + 1 };
      if (token === 'mhs') return { user: { id: MHS, role: 'MAHASISWA' }, exp: exp() };
      if (token === 'nonaktif') throw new ForbiddenException('AKUN_TIDAK_AKTIF');
      throw new UnauthorizedException();
    });
    const moduleRef = await Test.createTestingModule({
      providers: [PsikologGateway, { provide: AccessTokenService, useValue: { verifikasi } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}/psikolog`;
    gateway = app.get(PsikologGateway);
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });

  afterAll(() => app.close());

  function connect(auth: Record<string, unknown> | undefined, extraHeaders?: Record<string, string>) {
    const socket = io(url, { auth, extraHeaders, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    return socket;
  }

  const connected = (socket: ClientSocket) => new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });

  const rejected = (socket: ClientSocket) => new Promise<string>((resolve, reject) => {
    socket.once('connect', () => reject(new Error('should not connect')));
    socket.once('connect_error', (error) => resolve(error.message));
  });

  it.each([
    ['no token', undefined],
    ['an invalid token', { token: 'garbage' }],
    ['a student token', { token: 'mhs' }],
    ['an inactive psychologist', { token: 'nonaktif' }],
  ])('rejects the handshake with %s', async (_label, auth) => {
    expect(await rejected(connect(auth))).toBe('TIDAK_TERAUTENTIKASI');
  });

  it('accepts a psychologist token from auth or the Authorization header (Bearer prefix allowed)', async () => {
    await connected(connect({ token: 'Bearer psi-a' }));
    await connected(connect(undefined, { Authorization: 'Bearer psi-b' }));
    expect(verifikasi).toHaveBeenCalledWith('psi-a');
    expect(verifikasi).toHaveBeenCalledWith('psi-b');
  });

  it('delivers a targeted SOS notification only to the chosen psychologist within 5 seconds', async () => {
    const a = connect({ token: 'psi-a' });
    const b = connect({ token: 'psi-b' });
    await Promise.all([connected(a), connected(b)]);
    const receivedByB = jest.fn();
    b.on(EVENT.SOS_BARU, receivedByB);

    const start = Date.now();
    const received = new Promise<unknown>((resolve) => a.once(EVENT.SOS_BARU, resolve));
    gateway.kirimKePsikolog([PSI_A], EVENT.SOS_BARU, { id_sos: 'sos-1' });

    await expect(received).resolves.toEqual({ id_sos: 'sos-1' });
    expect(Date.now() - start).toBeLessThan(5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedByB).not.toHaveBeenCalled();
  });

  it('broadcasts case updates to every connected psychologist', async () => {
    const a = connect({ token: 'psi-a' });
    const b = connect({ token: 'psi-b' });
    await Promise.all([connected(a), connected(b)]);
    const both = Promise.all([
      new Promise((resolve) => a.once(EVENT.SOS_DIPERBARUI, resolve)),
      new Promise((resolve) => b.once(EVENT.SOS_DIPERBARUI, resolve)),
    ]);
    gateway.kirimKeSemuaPsikolog(EVENT.SOS_DIPERBARUI, { id_sos: 'sos-1', status_penanganan: 'DIAMBIL' });
    await expect(both).resolves.toHaveLength(2);
  });

  it('disconnects the socket when the access token expires', async () => {
    const socket = connect({ token: 'psi-short' });
    const expired = new Promise((resolve) => socket.once(EVENT.SESI_KEDALUWARSA, resolve));
    const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
    await connected(socket);
    await expect(expired).resolves.toEqual({ kode: 'TOKEN_KEDALUWARSA' });
    await disconnected;
  }, 10_000);

  describe('pemeriksaan ulang status akun selama koneksi terbuka (PBI-04, SCRUM-215)', () => {
    const previous = process.env.REALTIME_RECHECK_MS;
    beforeAll(() => { process.env.REALTIME_RECHECK_MS = '1000'; });
    afterAll(() => {
      if (previous === undefined) delete process.env.REALTIME_RECHECK_MS;
      else process.env.REALTIME_RECHECK_MS = previous;
    });

    it('memutus psikolog yang dinonaktifkan setelah tersambung dengan kode AKUN_TIDAK_AKTIF', async () => {
      const socket = connect({ token: 'psi-revoke' });
      const notice = new Promise((resolve) => socket.once(EVENT.SESI_KEDALUWARSA, resolve));
      const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
      await connected(socket);
      await expect(notice).resolves.toEqual({ kode: 'AKUN_TIDAK_AKTIF' });
      await disconnected;
      expect(verifikasi).toHaveBeenCalledWith('psi-revoke');
    }, 10_000);

    it('memutus psikolog yang password-nya di-reset admin dengan kode PASSWORD_WAJIB_DIGANTI', async () => {
      const socket = connect({ token: 'psi-reset' });
      const notice = new Promise((resolve) => socket.once(EVENT.SESI_KEDALUWARSA, resolve));
      const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
      await connected(socket);
      await expect(notice).resolves.toEqual({ kode: 'PASSWORD_WAJIB_DIGANTI' });
      await disconnected;
    }, 10_000);

    it('mempertahankan koneksi psikolog yang tetap aktif setelah pemeriksaan ulang', async () => {
      verifikasi.mockClear();
      const socket = connect({ token: 'psi-b' });
      await connected(socket);
      await new Promise((resolve) => setTimeout(resolve, 2300));
      expect(socket.connected).toBe(true);
      expect(verifikasi.mock.calls.filter(([t]) => t === 'psi-b').length).toBeGreaterThanOrEqual(2);
    }, 10_000);
  });
});
