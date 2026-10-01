<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class IssueReportAttachment extends Model
{
    protected $primaryKey = 'attachment_id';

    protected $fillable = [
        'issue_report_id',
        'file_url',
        'original_name',
        'uploaded_by',
    ];

    public function issueReport()
    {
        return $this->belongsTo(VehicleIssueReport::class, 'issue_report_id', 'issue_report_id');
    }

    public function uploadedBy()
    {
        return $this->belongsTo(User::class, 'uploaded_by');
    }
}
