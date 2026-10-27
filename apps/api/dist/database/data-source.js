"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
exports.default = new typeorm_1.DataSource({
    type: 'postgres',
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    migrationsTableName: 'schema_migrations',
    synchronize: false,
    logging: ['error', 'migration'],
});
//# sourceMappingURL=data-source.js.map