<?php

// Maintenance-schedule warning thresholds — one place, per
// VMS-IMPROVEMENT-PLAN.md's own convention for this kind of number ("Put
// thresholds in one config location," Phase D6). Nothing here BLOCKS a
// booking; it only decides when FleetController::checkScheduleConflicts()
// asks the caller to confirm before proceeding.

return [
    // A barangay's own daily volume of Scheduled entries (across every
    // vehicle) at or above this count triggers a "this day is getting
    // busy" warning.
    'daily_volume_warning_threshold' => 8,
];
