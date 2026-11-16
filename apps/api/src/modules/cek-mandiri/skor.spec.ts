import { buatRekomendasi, hitungSkor, tingkatRisiko } from './skor';

describe('Skor cek mandiri (PBI-15)', () => {
  it.each([
    [0, 'MINIMAL'], [4, 'MINIMAL'], [5, 'RINGAN'], [9, 'RINGAN'], [10, 'SEDANG'], [14, 'SEDANG'],
    [15, 'SEDANG_BERAT'], [19, 'SEDANG_BERAT'], [20, 'BERAT'], [27, 'BERAT'],
  ])('PHQ-9 skor %i → %s', (skor, tingkat) => {
    expect(tingkatRisiko('PHQ9', skor)).toBe(tingkat);
  });

  it.each([
    [0, 'MINIMAL'], [4, 'MINIMAL'], [5, 'RINGAN'], [9, 'RINGAN'], [10, 'SEDANG'], [14, 'SEDANG'],
    [15, 'BERAT'], [21, 'BERAT'],
  ])('GAD-7 skor %i → %s (tanpa pita sedang-berat)', (skor, tingkat) => {
    expect(tingkatRisiko('GAD7', skor)).toBe(tingkat);
  });

  it('sums answers', () => {
    expect(hitungSkor([3, 3, 3, 3, 3, 3, 3, 3, 3])).toBe(27);
    expect(hitungSkor([0, 1, 2, 3, 0, 1, 2])).toBe(9);
  });

  it('always routes a positive PHQ-9 item 9 to immediate help, even with a minimal total', () => {
    const r = buatRekomendasi(['MINIMAL'], true);
    expect(r.kode).toBe('BANTUAN_SEGERA');
    expect(r.tindakan).toEqual(expect.arrayContaining(['GENTA', 'HOTLINE', 'BOOKING_PRIORITAS']));
  });

  it.each([
    [['BERAT'], 'BANTUAN_SEGERA'],
    [['SEDANG_BERAT', 'RINGAN'], 'KONSELING'],
    [['SEDANG'], 'KONSELING'],
    [['RINGAN', 'MINIMAL'], 'DUKUNGAN_SEBAYA'],
    [['MINIMAL'], 'PERAWATAN_DIRI'],
  ] as const)('uses the highest severity %j → %s', (tingkat, kode) => {
    expect(buatRekomendasi([...tingkat], false).kode).toBe(kode);
  });
});
