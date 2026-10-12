<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('barangays', function (Blueprint $table) {
            // PSGC code — the stable identifier the nationwide boundary
            // importer keys on, so barangays are never matched by name alone
            // (hundreds of cities have a "Poblacion"). Nullable because rows
            // that predate the import, or that no upstream dataset carries,
            // keep a null code rather than being deleted.
            $table->string('code')->nullable()->unique()->after('name');
        });

        Schema::table('provinces', function (Blueprint $table) {
            $table->json('boundary')->nullable()->after('name');
            $table->string('boundary_source')->nullable()->after('boundary');
            $table->timestamp('boundary_verified_at')->nullable()->after('boundary_source');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('barangays', function (Blueprint $table) {
            $table->dropUnique(['code']);
            $table->dropColumn('code');
        });

        Schema::table('provinces', function (Blueprint $table) {
            $table->dropColumn(['boundary', 'boundary_source', 'boundary_verified_at']);
        });
    }
};
