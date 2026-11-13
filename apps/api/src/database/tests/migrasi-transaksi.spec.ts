import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { NotifikasiSosEskalasi1793800400000 } from '../migrations/1793800400000-NotifikasiSosEskalasi';

describe('Mode transaksi migrasi', () => {
  it('runs migrations per transaction (-t each) so ADD VALUE migrations can opt out', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
    expect(pkg.scripts['migration:run']).toMatch(/ -t each$/);
    expect(pkg.scripts['migration:revert']).toMatch(/ -t each$/);
  });

  it('runs SOS_ESKALASI outside a transaction because it uses the new enum value immediately', async () => {
    const migrasi = new NotifikasiSosEskalasi1793800400000();
    expect(migrasi.transaction).toBe(false);
    const queryRunner = { query: jest.fn() };
    await migrasi.up(queryRunner as never);
    expect(queryRunner.query.mock.calls[0][0]).toContain("ADD VALUE IF NOT EXISTS 'SOS_ESKALASI'");
    expect(queryRunner.query.mock.calls[1][0]).toContain("(payload->>'eskalasi')::boolean IS TRUE");
  });

  it('keeps migration files free of test files (TypeORM loads every file in migrations/)', () => {
    expect(readdirSync(join(__dirname, '../migrations')).filter((f) => f.includes('.spec.'))).toEqual([]);
  });
});
