import { MigrationInterface, QueryRunner } from 'typeorm';
export declare class RolesAndGrants1761500001000 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}
