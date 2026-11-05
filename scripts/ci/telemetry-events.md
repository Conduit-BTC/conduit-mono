# Telemetry Event Allowlist

Machine-checked allowlist consumed by `scripts/ci/check_telemetry_policy.ts`.
Each `<!-- telemetry-event: <name> properties=<csv> -->` marker declares one
event and the properties it may carry. Properties must be drawn from
`allowedTelemetryProperties` in that script; `estimated_gmv_sats` is permitted
only on `commerce_gmv_estimated`.

## App lifecycle

<!-- telemetry-event: app_load_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->
<!-- telemetry-event: client_error_result properties=event_name,app,page_url,page_path,surface,action,event_family,mode,status -->

## Signer

<!-- telemetry-event: signer_connected properties=event_name,app,page_url,page_path,method,status,count,time_bucket -->
<!-- telemetry-event: signer_disconnected properties=event_name,app,page_url,page_path,method,status,count,time_bucket -->
<!-- telemetry-event: anon_zap_signer_request_result properties=event_name,app,surface,action,status,latency_bucket -->

## Cart and checkout

<!-- telemetry-event: cart_add properties=event_name,app,page_url,page_path,surface,action,status,count_bucket,product_type,time_bucket -->
<!-- telemetry-event: cart_remove properties=event_name,app,page_url,page_path,surface,action,status,count_bucket,product_type,time_bucket -->
<!-- telemetry-event: cart_clear properties=event_name,app,page_url,page_path,surface,action,status,count_bucket,product_type,time_bucket -->
<!-- telemetry-event: checkout_initiated properties=event_name,app,page_url,page_path,surface,status,count_bucket,product_type,time_bucket -->
<!-- telemetry-event: checkout_step_result properties=event_name,app,page_url,page_path,surface,step,mode,rail,status,latency_bucket,count_bucket,amount_bucket,product_type,time_bucket,partner_code,source_domain,source_method -->
<!-- telemetry-event: checkout_success properties=event_name,app,page_url,page_path,surface,mode,rail,status,count_bucket,amount_bucket,product_type,time_bucket,partner_code,source_domain,source_method -->
<!-- telemetry-event: checkout_router_operation_result properties=event_name,app,page_url,page_path,step,status,latency_bucket,count_bucket -->
<!-- telemetry-event: checkout_result properties=event_name,app,page_url,page_path,surface,mode,rail,network,status,count_bucket,amount_bucket,product_type,time_bucket,partner_code,source_domain,source_method -->
<!-- telemetry-event: checkout_handoff_result properties=event_name,app,page_url,page_path,surface,handoff_stage,mode,partner_code,source_domain,source_method -->

## Relays and messaging

<!-- telemetry-event: relay_connect_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->
<!-- telemetry-event: relay_publish_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->
<!-- telemetry-event: nip17_compatibility_result properties=event_name,app,page_url,page_path,action,declaration_class,delivery_route,ack_outcome,repair_outcome,block_reason -->

## Wallet and payments

<!-- telemetry-event: wallet_connect_result properties=event_name,app,page_url,page_path,rail,method,status,latency_bucket,count,time_bucket -->
<!-- telemetry-event: payment_attempt_result properties=event_name,app,page_url,page_path,rail,mode,status,latency_bucket,amount_bucket,count,time_bucket -->

## Merchant

<!-- telemetry-event: merchant_setup_step_result properties=event_name,app,page_url,page_path,surface,step,status,count,time_bucket -->
<!-- telemetry-event: product_publish_result properties=event_name,app,page_url,page_path,event_family,status,latency_bucket,count,time_bucket -->
<!-- telemetry-event: shipping_publish_result properties=event_name,app,page_url,page_path,event_family,status,latency_bucket,count,time_bucket -->

## Browsing

<!-- telemetry-event: market_browse_action properties=event_name,app,page_url,page_path,surface,action,status,result_count_bucket,product_type,time_bucket -->
<!-- telemetry-event: product_detail_action properties=event_name,app,page_url,page_path,surface,action,product_type,time_bucket -->

## First-party commerce measurement (Worker only)

<!-- telemetry-event: commerce_gmv_estimated properties=estimated_gmv_sats -->
