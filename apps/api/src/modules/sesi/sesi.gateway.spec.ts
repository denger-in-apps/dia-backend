import { ForbiddenException, INestApplication, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AccessTokenService } from '../../common/auth/access-token.service';
import { RuangSesiService } from './ruang-sesi.service';
import { EVENT_SESI } from './sesi.constants';
import { SesiGateway } from './sesi.gateway';

describe('SesiGateway (Socket.IO /sesi)', () => {
  const MHS = '11111111-1111-4111-8111-111111111111';
  const PSI = '22222222-2222-4222-8222-222222222222';
  const ID_SESI = '44444444-4444-4444-8444-444444444444';
  let app: INestApplication;
  let gateway: SesiGateway;
  let url: string;
  let ruang: Record<string, jest.Mock>;
  let status: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const exp = () => Math.floor(Date.now() / 1000) + 900;
    const verifikasi = jest.fn(async (token: string) => {
      if (token === 'mhs') return { user: { id: MHS, role: 'MAHASISWA' }, exp: exp() };
      if (token === 'psi') return { user: { id: PSI, role: 'PSIKOLOG' }, exp: exp() };
      if (token === 'admin') return { user: { id: 'x', role: 'DOSEN_ADMIN' }, exp: exp() };
      throw new UnauthorizedException();
    });
    ruang = {
      pastikanBolehGabung: jest.fn(async (user: { id: string }, idSesi: string) => {
        if (idSesi !== ID_SESI || ![MHS, PSI].includes(user.id)) {
          throw new NotFoundException({ kode: 'SESI_TIDAK_DITEMUKAN', pesan: 'Sesi tidak ditemukan' });
        }
        if (status === 'SELESAI') throw new ForbiddenException({ kode: 'SESI_SUDAH_BERAKHIR', pesan: 'x' });
        return { id_sesi: idSesi, status_sesi: status };
      }),
      kirimPesan: jest.fn(async (user: { role: string }, idSesi: string, ciphertext: string, nonce: string) => ({
        id_pesan: 'p1', id_sesi: idSesi, pengirim: user.role, ciphertext, nonce, created_at: new Date(),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SesiGateway,
        { provide: AccessTokenService, useValue: { verifikasi } },
        { provide: RuangSesiService, useValue: ruang },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}/sesi`;
    gateway = app.get(SesiGateway);
  });

  beforeEach(() => {
    status = 'BERLANGSUNG';
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });

  afterAll(() => app.close());

  const connect = (token?: string) => {
    const socket = io(url, { auth: token ? { token } : undefined, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    return socket;
  };
  const connected = (socket: ClientSocket) => new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const emit = (socket: ClientSocket, event: string, body: unknown) =>
    socket.timeout(2000).emitWithAck(event, body) as Promise<{ ok: boolean; kode?: string; data?: unknown }>;
  const next = (socket: ClientSocket, event: string) => new Promise<unknown>((resolve) => socket.once(event, resolve));

  it.each([undefined, 'garbage', 'admin'])('rejects the handshake for token %s', async (token) => {
    const socket = connect(token);
    await expect(connected(socket)).rejects.toThrow('TIDAK_TERAUTENTIKASI');
  });

  it('lets both participants join and relays encrypted messages to the room', async () => {
    const mhs = connect('mhs');
    const psi = connect('psi');
    await Promise.all([connected(mhs), connected(psi)]);
    expect(await emit(mhs, EVENT_SESI.GABUNG, { id_sesi: ID_SESI })).toEqual({ ok: true });
    expect(await emit(psi, EVENT_SESI.GABUNG, { id_sesi: ID_SESI })).toEqual({ ok: true });

    const diterima = next(psi, EVENT_SESI.PESAN_BARU);
    const ack = await emit(mhs, EVENT_SESI.KIRIM_PESAN, { id_sesi: ID_SESI, ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=' });
    expect(ack.ok).toBe(true);
    expect(await diterima).toEqual(expect.objectContaining({ id_pesan: 'p1', pengirim: 'MAHASISWA', ciphertext: 'Y2lwaGVy' }));
    expect(ruang.kirimPesan).toHaveBeenCalledWith({ id: MHS, role: 'MAHASISWA' }, ID_SESI, 'Y2lwaGVy', 'bm9uY2U=');
  });

  it('refuses to join sessions of others or finished sessions', async () => {
    const mhs = connect('mhs');
    await connected(mhs);
    expect(await emit(mhs, EVENT_SESI.GABUNG, { id_sesi: '55555555-5555-4555-8555-555555555555' }))
      .toEqual(expect.objectContaining({ ok: false, kode: 'SESI_TIDAK_DITEMUKAN' }));
    expect(await emit(mhs, EVENT_SESI.GABUNG, { id_sesi: 'bukan-uuid' }))
      .toEqual(expect.objectContaining({ ok: false, kode: 'PAYLOAD_TIDAK_VALID' }));
    status = 'SELESAI';
    expect(await emit(mhs, EVENT_SESI.GABUNG, { id_sesi: ID_SESI }))
      .toEqual(expect.objectContaining({ ok: false, kode: 'SESI_SUDAH_BERAKHIR' }));
  });

  it('relays WebRTC signaling only to the other participant after joining', async () => {
    const mhs = connect('mhs');
    const psi = connect('psi');
    await Promise.all([connected(mhs), connected(psi)]);
    expect(await emit(mhs, EVENT_SESI.SINYAL_RTC, { id_sesi: ID_SESI, data: { type: 'offer' } }))
      .toEqual(expect.objectContaining({ ok: false, kode: 'BELUM_BERGABUNG' }));
    await emit(mhs, EVENT_SESI.GABUNG, { id_sesi: ID_SESI });
    await emit(psi, EVENT_SESI.GABUNG, { id_sesi: ID_SESI });
    const sendiri = jest.fn();
    mhs.on(EVENT_SESI.SINYAL_RTC, sendiri);
    const diterima = next(psi, EVENT_SESI.SINYAL_RTC);
    expect((await emit(mhs, EVENT_SESI.SINYAL_RTC, { id_sesi: ID_SESI, data: { type: 'offer', sdp: 'v=0' } })).ok).toBe(true);
    expect(await diterima).toEqual({ id_sesi: ID_SESI, dari: 'MAHASISWA', data: { type: 'offer', sdp: 'v=0' } });
    expect(sendiri).not.toHaveBeenCalled();
    expect(await emit(mhs, EVENT_SESI.SINYAL_RTC, { id_sesi: ID_SESI, data: 'x'.repeat(20_000) }))
      .toEqual(expect.objectContaining({ ok: false, kode: 'PAYLOAD_TIDAK_VALID' }));
  });

  it('broadcasts status changes and closes the room when the session ends', async () => {
    const mhs = connect('mhs');
    await connected(mhs);
    await emit(mhs, EVENT_SESI.GABUNG, { id_sesi: ID_SESI });
    const diterima = next(mhs, EVENT_SESI.STATUS);
    gateway.siarkanStatus(ID_SESI, { id_sesi: ID_SESI, status_sesi: 'SELESAI' });
    expect(await diterima).toEqual({ id_sesi: ID_SESI, status_sesi: 'SELESAI' });

    const pesan = jest.fn();
    mhs.on(EVENT_SESI.PESAN_BARU, pesan);
    gateway.siarkanPesan(ID_SESI, { id_pesan: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pesan).not.toHaveBeenCalled();
  });

  it('throttles message floods per socket', async () => {
    const mhs = connect('mhs');
    await connected(mhs);
    const body = { id_sesi: ID_SESI, ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=' };
    const acks: { ok: boolean; kode?: string }[] = [];
    for (let i = 0; i < 31; i++) acks.push(await emit(mhs, EVENT_SESI.KIRIM_PESAN, body));
    expect(acks.slice(0, 30).every((ack) => ack.ok)).toBe(true);
    expect(acks[30]).toEqual(expect.objectContaining({ ok: false, kode: 'TERLALU_CEPAT' }));
  });
});
