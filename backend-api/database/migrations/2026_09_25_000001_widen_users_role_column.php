<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * `role` started as enum('Admin','Custodian','Maintenance Personnel')
     * (0001_01_01_000000_create_users_table.php:20), which Postgres compiles
     * to a real CHECK constraint — unlike SQLite, where a later migration
     * (2026_08_18_000002_add_barangay_id_to_users_table.php) rebuilt the
     * `users` table to add a foreign key and silently dropped the CHECK
     * clause as a side effect. That's why a Super Admin (role = 'Super
     * Admin', never in the enum) already works on local/testing SQLite but
     * would be rejected outright on a freshly-migrated Postgres database —
     * see 2026_08_31_000001_create_super_admin_account.php and
     * database/seeders/UserSeeder.php, both of which insert one.
     *
     * `role` is validated everywhere it's actually written — registration
     * (AuthController), UserController::ROLES, SuperAdminController::ROLES —
     * none of which ever let 'Super Admin' through the app. The DB no
     * longer needs to duplicate that as a fixed list; it only needs to stop
     * rejecting a value the app itself never produces except through the
     * (now production-safe) `superadmin:create` command.
     */
    public function up(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            // Postgres names an inline column CHECK constraint
            // "<table>_<column>_check" by default; enum() never gave it an
            // explicit name, so this is what Schema::create's enum() would
            // have produced. Dropped directly — Blueprint::change() doesn't
            // track or remove a CHECK constraint that was never registered
            // as Blueprint state for this column, only the column's
            // type/length/nullable/default.
            DB::statement('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
        }

        Schema::table('users', function (Blueprint $table) {
            $table->string('role', 50)->default('Custodian')->change();
        });
    }

    /**
     * Deliberately not restored: re-adding the CHECK constraint would
     * reject any 'Super Admin' row created after this migration ran,
     * breaking the rollback itself on a database that already has one. If
     * this ever needs reverting, drop any 'Super Admin' rows by hand first.
     */
    public function down(): void
    {
        //
    }
};
