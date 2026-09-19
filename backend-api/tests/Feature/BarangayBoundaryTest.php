<?php

namespace Tests\Feature;

use App\Rules\ValidGeoBoundary;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * GEOJSON BOUNDARY VALIDATION
 *
 * Guards the shape of anything we're willing to store as a boundary, and the
 * "is this even in the right part of the country" sanity check — see
 * docs/GEOJSON_BOUNDARY_RULES.md.
 */
class BarangayBoundaryTest extends TestCase
{
    private const SQUARE = [[123.9, 10.3], [124.0, 10.3], [124.0, 10.4], [123.9, 10.4], [123.9, 10.3]];

    #[Test]
    public function it_accepts_well_formed_polygons(): void
    {
        $this->assertTrue(ValidGeoBoundary::isValid(['type' => 'Polygon', 'coordinates' => [self::SQUARE]]));
        $this->assertTrue(ValidGeoBoundary::isValid(['type' => 'MultiPolygon', 'coordinates' => [[self::SQUARE]]]));
    }

    #[Test]
    public function it_rejects_malformed_geometry(): void
    {
        $this->assertFalse(ValidGeoBoundary::isValid(['type' => 'Point', 'coordinates' => [123.9, 10.3]]));
        $this->assertFalse(ValidGeoBoundary::isValid(['type' => 'Polygon', 'coordinates' => []]));
        $this->assertFalse(ValidGeoBoundary::isValid('not-an-array'));

        // Unclosed ring.
        $this->assertFalse(ValidGeoBoundary::isValid([
            'type' => 'Polygon',
            'coordinates' => [[[123.9, 10.3], [124.0, 10.3], [124.0, 10.4], [123.95, 10.35]]],
        ]));

        // Too few points to enclose an area.
        $this->assertFalse(ValidGeoBoundary::isValid([
            'type' => 'Polygon',
            'coordinates' => [[[123.9, 10.3], [124.0, 10.3], [123.9, 10.3]]],
        ]));

        // Latitude/longitude swapped, pushing latitude past 90.
        $this->assertFalse(ValidGeoBoundary::isValid([
            'type' => 'Polygon',
            'coordinates' => [[[10.3, 123.9], [10.4, 123.9], [10.4, 124.0], [10.3, 123.9]]],
        ]));
    }

    #[Test]
    public function containment_recognises_a_shape_inside_its_parent(): void
    {
        $parent = ['type' => 'Polygon', 'coordinates' => [[[123.0, 10.0], [125.0, 10.0], [125.0, 11.0], [123.0, 11.0], [123.0, 10.0]]]];
        $child = ['type' => 'Polygon', 'coordinates' => [self::SQUARE]];

        $this->assertTrue(ValidGeoBoundary::isApproximatelyWithin($child, $parent));
    }

    #[Test]
    public function containment_rejects_a_shape_from_another_province(): void
    {
        $cebu = ['type' => 'Polygon', 'coordinates' => [[[123.0, 10.0], [125.0, 10.0], [125.0, 11.0], [123.0, 11.0], [123.0, 10.0]]]];
        // A box over Davao, ~500km away.
        $davao = ['type' => 'Polygon', 'coordinates' => [[[125.5, 7.0], [125.7, 7.0], [125.7, 7.2], [125.5, 7.2], [125.5, 7.0]]]];

        $this->assertFalse(ValidGeoBoundary::isApproximatelyWithin($davao, $cebu));
        $this->assertFalse(ValidGeoBoundary::isNearby($davao, $cebu), 'A different province must not read as merely offshore.');
    }

    #[Test]
    public function an_offshore_island_is_outside_the_outline_but_still_nearby(): void
    {
        // Mainland municipality...
        $mainland = ['type' => 'Polygon', 'coordinates' => [[[123.0, 10.0], [123.2, 10.0], [123.2, 10.2], [123.0, 10.2], [123.0, 10.0]]]];
        // ...and one of its barangays on an island just off the coast. This is
        // the Bantayan/Gilutongan case: real, and not inside the drawn shape.
        $island = ['type' => 'Polygon', 'coordinates' => [[[123.3, 10.25], [123.34, 10.25], [123.34, 10.29], [123.3, 10.29], [123.3, 10.25]]]];

        $this->assertFalse(ValidGeoBoundary::isApproximatelyWithin($island, $mainland));
        $this->assertTrue(ValidGeoBoundary::isNearby($island, $mainland));
    }
}
