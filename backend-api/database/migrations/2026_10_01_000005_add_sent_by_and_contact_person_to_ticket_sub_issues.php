<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            // Who physically takes the vehicle to the shop, and who to talk
            // to there — separate from the shop's phone number.
            $table->string('external_sent_by')->nullable()->after('external_shop_contact');
            $table->string('external_contact_person')->nullable()->after('external_sent_by');
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn(['external_sent_by', 'external_contact_person']);
        });
    }
};
