# Merchant listing area place data

Merchant's optional listing area picker uses the [GeoNames cities500 extract](https://download.geonames.org/export/dump/readme.txt) and its administrative name tables. GeoNames data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). GeoNames contributors provide the underlying place records; Conduit only partitions and compresses their public data for local browser search.

The checked-in generation was downloaded on 2026-09-24. Exact source SHA-256 hashes, row counts, and per-country JSON and gzip byte sizes are in [`apps/merchant/public/places/source.json`](../../apps/merchant/public/places/source.json). The inputs were `cities500.zip`, `admin1CodesASCII.txt`, and `admin2Codes.txt` from `https://download.geonames.org/export/dump/`. Rebuild with:

```sh
bun scripts/generate-merchant-places.ts cities500.zip admin1CodesASCII.txt admin2Codes.txt
```

The generator reads `SHIPPING_COUNTRIES` at build time and writes one compact JSON file for each accepted country other than the United States. US places are partitioned by their GeoNames first administrative code into `/places/US/<state>.json`; the generated `usListingAreaStates.ts` contains only the codes and names represented by those records. There is no combined `/places/US.json`. The US picker requires a state and loads only its file. Other countries keep the Country → Place flow and load one country file.

Each row contains the GeoNames ID, place name, county or second administrative name, region or first administrative name, representative latitude and longitude, and population. A country with no matching cities500 record gets an empty file. Coordinates are used locally to derive a four-character geohash for an approximate public listing-area hint. They are not a merchant address or pickup location. The source manifest records per-country and per-US-state JSON and gzip byte sizes.

GeoNames cities500 includes populated places with more than 500 residents and certain administrative seats. Small settlements, missing administrative names, and boundary or naming errors can leave no suitable suggestion. Merchants can publish without a listing area; they must select a listed suggestion to add one.

In this snapshot, accepted country files for `AQ`, `BV`, `HM`, and `UM` are empty. The US source records cover 50 states and the District of Columbia. Other US territories have their own accepted country codes when present in `SHIPPING_COUNTRIES`. Among 220,174 place rows, 25,035 lack a second administrative name and 449 lack a first administrative name. Search still includes the place and available administrative names.
