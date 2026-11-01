// The routing engine (engine/ios): starts its server on a free port of 127.0.0.1, each search up to
// search_mb megabytes, and returns the port, 0 when the routing data is missing.
#include <stdint.h>
uint16_t richi_engine_start(uint8_t threads, uint32_t search_mb);
