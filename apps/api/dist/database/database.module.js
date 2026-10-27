"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseModule = exports.DatabasePoolLifecycle = exports.DATABASE_POOL = void 0;
const common_1 = require("@nestjs/common");
const pg_1 = require("pg");
exports.DATABASE_POOL = Symbol('DATABASE_POOL');
let DatabasePoolLifecycle = class DatabasePoolLifecycle {
    constructor(pool) {
        this.pool = pool;
    }
    async onApplicationShutdown() {
        await this.pool.end();
    }
};
exports.DatabasePoolLifecycle = DatabasePoolLifecycle;
exports.DatabasePoolLifecycle = DatabasePoolLifecycle = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [pg_1.Pool])
], DatabasePoolLifecycle);
let DatabaseModule = class DatabaseModule {
};
exports.DatabaseModule = DatabaseModule;
exports.DatabaseModule = DatabaseModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        providers: [
            {
                provide: exports.DATABASE_POOL,
                useFactory: () => {
                    const connectionString = process.env.DATABASE_URL;
                    if (!connectionString)
                        throw new Error('DATABASE_URL wajib diisi');
                    return new pg_1.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
                },
            },
            {
                provide: DatabasePoolLifecycle,
                useFactory: (pool) => new DatabasePoolLifecycle(pool),
                inject: [exports.DATABASE_POOL],
            },
        ],
        exports: [exports.DATABASE_POOL],
    })
], DatabaseModule);
//# sourceMappingURL=database.module.js.map