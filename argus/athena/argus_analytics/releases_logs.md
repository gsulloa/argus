---
system:
  kind: table
  schema: argus_analytics
  name: releases_logs
  primary_key: null
  columns:
  - name: request_date
    type: date
  - name: request_time
    type: string
  - name: x_edge_location
    type: string
  - name: sc_bytes
    type: bigint
  - name: c_ip
    type: string
  - name: cs_method
    type: string
  - name: cs_host
    type: string
  - name: cs_uri_stem
    type: string
  - name: sc_status
    type: int
  - name: cs_referer
    type: string
  - name: cs_user_agent
    type: string
  - name: cs_uri_query
    type: string
  - name: cs_cookie
    type: string
  - name: x_edge_result_type
    type: string
  - name: x_edge_request_id
    type: string
  - name: x_host_header
    type: string
  - name: cs_protocol
    type: string
  - name: cs_bytes
    type: bigint
  - name: time_taken
    type: float
  - name: x_forwarded_for
    type: string
  - name: ssl_protocol
    type: string
  - name: ssl_cipher
    type: string
  - name: x_edge_response_result_type
    type: string
  - name: cs_protocol_version
    type: string
  - name: fle_status
    type: string
  - name: fle_encrypted_fields
    type: int
  - name: c_port
    type: int
  - name: time_to_first_byte
    type: float
  - name: x_edge_detailed_result_type
    type: string
  - name: sc_content_type
    type: string
  - name: sc_content_len
    type: bigint
  - name: sc_range_start
    type: bigint
  - name: sc_range_end
    type: bigint
  last_synced: 2026-06-19T10:05:40.232715Z
  deleted_in_db: false
human: {}
---
# releases_logs
