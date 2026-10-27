"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshTokenFamilies1793000000000 = void 0;
class RefreshTokenFamilies1793000000000 {
    constructor() {
        this.name = 'RefreshTokenFamilies1793000000000';
    }
    async up(queryRunner) {
        await queryRunner.query(`
      ALTER TABLE refresh_token ADD COLUMN token_family_id uuid;
      UPDATE refresh_token SET token_family_id = id WHERE token_family_id IS NULL;
      ALTER TABLE refresh_token ALTER COLUMN token_family_id SET DEFAULT gen_random_uuid();
      ALTER TABLE refresh_token ALTER COLUMN token_family_id SET NOT NULL;
      ALTER TABLE refresh_token ADD COLUMN replaced_by uuid REFERENCES refresh_token(id);
      CREATE INDEX idx_refresh_token_family ON refresh_token(token_family_id);
    `);
    }
    async down(queryRunner) {
        await queryRunner.query(`
      DROP INDEX IF EXISTS idx_refresh_token_family;
      ALTER TABLE refresh_token DROP COLUMN IF EXISTS replaced_by;
      ALTER TABLE refresh_token DROP COLUMN IF EXISTS token_family_id;
    `);
    }
}
exports.RefreshTokenFamilies1793000000000 = RefreshTokenFamilies1793000000000;
//# sourceMappingURL=1793000000000-RefreshTokenFamilies.js.map