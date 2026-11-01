import Darwin
import os

/// The app's memory as iOS counts it against its limit: now, at its peak, and what is left before iOS
/// ends the app.
struct Memory {
    let footprint: UInt64
    let peak: UInt64
    let available: UInt64

    static func now() -> Memory {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        let ok = result == KERN_SUCCESS
        return Memory(footprint: ok ? info.phys_footprint : 0, peak: ok ? UInt64(info.ledger_phys_footprint_peak) : 0,
                      available: UInt64(os_proc_available_memory()))
    }
}
