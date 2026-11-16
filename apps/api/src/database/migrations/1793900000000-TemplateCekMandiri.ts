import { MigrationInterface, QueryRunner } from 'typeorm';

const OPSI = [
  { nilai: 0, label: 'Tidak sama sekali' },
  { nilai: 1, label: 'Beberapa hari' },
  { nilai: 2, label: 'Lebih dari separuh waktu' },
  { nilai: 3, label: 'Hampir setiap hari' },
];
const PEMBUKA = 'Selama 2 minggu terakhir, seberapa sering Anda terganggu oleh masalah-masalah berikut?';

const PHQ9 = [
  'Kurang tertarik atau bergairah dalam melakukan apa pun',
  'Merasa murung, sedih, atau putus asa',
  'Sulit tidur, mudah terbangun, atau terlalu banyak tidur',
  'Merasa lelah atau kurang bertenaga',
  'Kurang nafsu makan atau terlalu banyak makan',
  'Merasa buruk tentang diri sendiri — merasa gagal atau telah mengecewakan diri sendiri atau keluarga',
  'Sulit berkonsentrasi, misalnya saat membaca atau menonton',
  'Bergerak atau berbicara sangat lambat sehingga orang lain menyadarinya, atau sebaliknya sangat gelisah sehingga lebih banyak bergerak dari biasanya',
  'Berpikir lebih baik mati atau ingin melukai diri sendiri dengan cara apa pun',
];
const GAD7 = [
  'Merasa gugup, cemas, atau tegang',
  'Tidak mampu menghentikan atau mengendalikan rasa khawatir',
  'Terlalu mengkhawatirkan berbagai hal',
  'Sulit untuk merasa santai',
  'Sangat gelisah sehingga sulit untuk duduk diam',
  'Mudah kesal atau mudah tersinggung',
  'Merasa takut seolah-olah sesuatu yang buruk akan terjadi',
];

const butir = (daftar: string[]) => JSON.stringify({
  pertanyaan_pembuka: PEMBUKA,
  butir: daftar.map((teks, i) => ({ no: i + 1, teks })),
  opsi: OPSI,
});

/**
 * PBI-15 (SCRUM-258): template kuesioner awal PHQ-9 v1 dan GAD-7 v1 (Bahasa Indonesia).
 * PHQ-9/GAD-7 bebas dipakai (Pfizer, public domain). Terjemahan WAJIB diverifikasi
 * psikolog/PO terhadap versi Indonesia tervalidasi sebelum rilis (02-backend.md §9.1);
 * revisi dibuat sebagai versi baru agar hasil lama tetap merujuk template aslinya.
 */
export class TemplateCekMandiri1793900000000 implements MigrationInterface {
  name = 'TemplateCekMandiri1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO template_kuesioner (kode, nama, versi, butir, aktif)
       VALUES ('PHQ9', 'Patient Health Questionnaire-9 (PHQ-9)', 1, $1::jsonb, true),
              ('GAD7', 'Generalized Anxiety Disorder-7 (GAD-7)', 1, $2::jsonb, true)
       ON CONFLICT (kode, versi) DO NOTHING`,
      [butir(PHQ9), butir(GAD7)],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Hanya menghapus template yang belum dipakai hasil cek mandiri.
    await queryRunner.query(
      `DELETE FROM template_kuesioner t WHERE t.versi = 1 AND t.kode IN ('PHQ9', 'GAD7')
         AND NOT EXISTS (SELECT 1 FROM hasil_cek_mandiri h
                         WHERE h.id_template_phq9 = t.id_template OR h.id_template_gad7 = t.id_template)`,
    );
  }
}
