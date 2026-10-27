import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'postgres',
  url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  migrationsTableName: 'schema_migrations',
  synchronize: false,
  logging: ['error', 'migration'],
});
