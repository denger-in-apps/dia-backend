import { readFileSync } from 'fs';
import { join } from 'path';
import { KONFIGURASI_DEFAULT } from '../../modules/eskalasi/konfigurasi-sos.service';
import {
  HOTLINE_LABEL_BENAR,
  HOTLINE_LABEL_RUSAK,
  PerbaikiLabelHotline1793800200000,
} from '../migrations/1793800200000-PerbaikiLabelHotline';

describe('Migrasi PerbaikiLabelHotline (SCRUM-236)', () => {
  it('targets exactly the mojibake default that 0001_init.sql inserts', () => {
    const sql = readFileSync(join(__dirname, '../sql/0001_init.sql'), 'utf8');
    expect(sql).toContain(`DEFAULT '${HOTLINE_LABEL_RUSAK}'`);
  });

  it('fixes rows still holding the broken label and the column default to the app default', async () => {
    expect(HOTLINE_LABEL_BENAR).toBe(KONFIGURASI_DEFAULT.hotline_label);
    const queryRunner = { query: jest.fn().mockResolvedValue([]) };
    await new PerbaikiLabelHotline1793800200000().up(queryRunner as never);
    expect(queryRunner.query.mock.calls[0]).toEqual([
      'UPDATE konfigurasi_sos SET hotline_label = $1 WHERE hotline_label = $2',
      [HOTLINE_LABEL_BENAR, HOTLINE_LABEL_RUSAK],
    ]);
    expect(queryRunner.query.mock.calls[1][0]).toContain(`SET DEFAULT '${HOTLINE_LABEL_BENAR}'`);
  });
});
