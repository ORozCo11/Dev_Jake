<?php

namespace App\Support;

/**
 * Locates boundary files in the faeldon/philippines-json-maps dataset.
 *
 * We read the 2019 vintage on purpose. The 2023 set uses the revised PSGC
 * numbering (Bantayan is 702209000 there, 072209000 here), so adopting it
 * would mean building and maintaining a crosswalk for all 1,634 cities; the
 * 2019 codes match the ones already seeded in `provinces.code`/`cities.code`
 * exactly, and these outlines are map decoration rather than survey data.
 *
 * Pure path building only — no I/O — so the importer's --from directory mode
 * and its HTTP mode resolve names through identical code.
 */
class PhilippinesJsonMaps
{
    public const SOURCE_LABEL = 'philippines-json-maps-2019';

    private const BASE_URL = 'https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/2019/geojson';

    public static function barangayFile(string $cityCode, string $resolution = 'medres'): string
    {
        return "barangays/{$resolution}/barangays-municity-ph{$cityCode}.0.01.json";
    }

    public static function provinceFile(string $regionCode, string $resolution = 'medres'): string
    {
        return "provinces/{$resolution}/provinces-region-ph{$regionCode}.0.01.json";
    }

    public static function url(string $file): string
    {
        return self::BASE_URL . '/' . $file;
    }

    /** A province's region code is its first two digits: 072200000 -> 070000000. */
    public static function regionCodeFor(string $provinceCode): string
    {
        return substr($provinceCode, 0, 2) . '0000000';
    }

    /** "PH072209007" -> "072209007"; returns null for anything else. */
    public static function stripPcodePrefix(?string $pcode): ?string
    {
        if (! $pcode) {
            return null;
        }

        $code = preg_replace('/^ph/i', '', trim($pcode));

        return preg_match('/^\d{9}$/', $code) ? $code : null;
    }
}
