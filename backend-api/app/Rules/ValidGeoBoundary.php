<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * GeoJSON boundary rule — see docs/GEOJSON_BOUNDARY_RULES.md (Rules 7 & 8).
 *
 * Passes when the value is a GeoJSON Polygon/MultiPolygon geometry whose rings
 * are closed, have enough points to enclose an area, and carry coordinates in
 * real [longitude, latitude] ranges.
 *
 * The checks are also exposed as plain static methods so code that already
 * holds a decoded geometry (e.g. the registration-time boundary import in
 * Barangay::findOrCreateForCity) can call them directly without routing
 * through the validator.
 */
class ValidGeoBoundary implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! static::isValid($value)) {
            $fail('The :attribute field must be a valid GeoJSON Polygon or MultiPolygon.');
        }
    }

    /**
     * Structural validation only — it does not check that the shape sits
     * anywhere in particular (see isApproximatelyWithin for that).
     */
    public static function isValid(mixed $geometry): bool
    {
        if (! is_array($geometry)) {
            return false;
        }

        $type = $geometry['type'] ?? null;
        $coordinates = $geometry['coordinates'] ?? null;

        if (! in_array($type, ['Polygon', 'MultiPolygon'], true) || ! is_array($coordinates) || $coordinates === []) {
            return false;
        }

        foreach (static::polygonsOf($geometry) as $rings) {
            if (! is_array($rings) || $rings === []) {
                return false;
            }

            foreach ($rings as $ring) {
                if (! static::isValidRing($ring)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * "Roughly inside" test used to catch a boundary that belongs to a
     * completely different city/province. This is a centroid-in-polygon check,
     * NOT true geometric containment — a shape that merely overlaps the parent
     * still passes, which is deliberate: the source datasets disagree slightly
     * at the edges and these outlines are decorative, not survey-grade.
     */
    public static function isApproximatelyWithin(array $inner, array $outer): bool
    {
        $point = static::centroid($inner);

        if (! $point) {
            return false;
        }

        foreach (static::polygonsOf($outer) as $rings) {
            if (isset($rings[0]) && static::pointInRing($point, $rings[0])) {
                return true;
            }
        }

        return false;
    }

    /**
     * Far looser companion to isApproximatelyWithin: is the shape at least in
     * the right general area? Islands routinely sit outside their own
     * municipality's drawn outline — the city polygons we hold come from a
     * different PSGC vintage and often cover only the main landmass, so a
     * strict test throws away real barangays like Bantayan's offshore islands.
     * A tolerance of a few tenths of a degree still catches the mistake this
     * is actually for: a polygon from an entirely different province.
     */
    public static function isNearby(array $inner, array $outer, float $toleranceDegrees = 0.25): bool
    {
        $point = static::centroid($inner);
        $box = static::boundingBox($outer);

        if (! $point || ! $box) {
            return false;
        }

        [$x, $y] = $point;
        [$minX, $minY, $maxX, $maxY] = $box;

        return $x >= $minX - $toleranceDegrees && $x <= $maxX + $toleranceDegrees
            && $y >= $minY - $toleranceDegrees && $y <= $maxY + $toleranceDegrees;
    }

    /** [minLng, minLat, maxLng, maxLat] across every ring of the geometry. */
    private static function boundingBox(array $geometry): ?array
    {
        $minX = $minY = INF;
        $maxX = $maxY = -INF;

        foreach (static::polygonsOf($geometry) as $rings) {
            foreach ($rings as $ring) {
                foreach ($ring as [$lng, $lat]) {
                    $minX = min($minX, $lng);
                    $maxX = max($maxX, $lng);
                    $minY = min($minY, $lat);
                    $maxY = max($maxY, $lat);
                }
            }
        }

        return is_infinite($minX) ? null : [$minX, $minY, $maxX, $maxY];
    }

    /** Normalizes Polygon vs MultiPolygon into a list of polygons (each a list of rings). */
    private static function polygonsOf(array $geometry): array
    {
        $coordinates = $geometry['coordinates'] ?? [];

        return ($geometry['type'] ?? null) === 'Polygon' ? [$coordinates] : $coordinates;
    }

    private static function isValidRing(mixed $ring): bool
    {
        // 3 distinct corners plus the repeated closing point.
        if (! is_array($ring) || count($ring) < 4) {
            return false;
        }

        foreach ($ring as $point) {
            if (! is_array($point) || count($point) < 2) {
                return false;
            }

            [$lng, $lat] = $point;

            if (! is_numeric($lng) || ! is_numeric($lat)) {
                return false;
            }

            if ($lng < -180 || $lng > 180 || $lat < -90 || $lat > 90) {
                return false;
            }
        }

        $first = $ring[0];
        $last = $ring[count($ring) - 1];

        return abs($first[0] - $last[0]) < 1e-9 && abs($first[1] - $last[1]) < 1e-9;
    }

    private static function centroid(array $geometry): ?array
    {
        $ring = static::polygonsOf($geometry)[0][0] ?? null;

        if (! is_array($ring) || $ring === []) {
            return null;
        }

        $sumLng = 0;
        $sumLat = 0;

        foreach ($ring as [$lng, $lat]) {
            $sumLng += $lng;
            $sumLat += $lat;
        }

        return [$sumLng / count($ring), $sumLat / count($ring)];
    }

    /** Standard ray-casting point-in-polygon test. */
    private static function pointInRing(array $point, array $ring): bool
    {
        [$x, $y] = $point;
        $inside = false;
        $count = count($ring);

        for ($i = 0, $j = $count - 1; $i < $count; $j = $i++) {
            [$xi, $yi] = $ring[$i];
            [$xj, $yj] = $ring[$j];

            $straddles = ($yi > $y) !== ($yj > $y);

            if ($straddles && $x < ($xj - $xi) * ($y - $yi) / ($yj - $yi) + $xi) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }
}
