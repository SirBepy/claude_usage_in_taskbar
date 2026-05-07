use crate::types::AudioOutputDevice;
use cpal::traits::{DeviceTrait, HostTrait};

/// Enumerate system audio output devices.
/// Returns an empty Vec (not an error) if enumeration fails, so the frontend
/// can still show "System default".
pub fn list_audio_output_devices_impl() -> Vec<AudioOutputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok());
    match host.output_devices() {
        Ok(devs) => {
            let mut default_marked = false;
            devs.filter_map(|d| d.name().ok())
                .map(|name| {
                    let is_default = !default_marked && Some(&name) == default_name.as_ref();
                    if is_default { default_marked = true; }
                    AudioOutputDevice { name, is_default }
                })
                .collect()
        }
        Err(e) => {
            log::warn!("audio: device enumeration failed: {e}");
            vec![]
        }
    }
}

#[tauri::command]
pub fn list_audio_output_devices() -> Vec<AudioOutputDevice> {
    list_audio_output_devices_impl()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_audio_output_devices_does_not_panic() {
        let devices = list_audio_output_devices_impl();
        // In headless CI this may be empty -- that's fine.
        // When devices exist, names must be non-empty.
        for d in &devices {
            assert!(!d.name.is_empty(), "device name must not be empty");
        }
    }

    #[test]
    fn at_most_one_device_is_default() {
        let devices = list_audio_output_devices_impl();
        let defaults: Vec<_> = devices.iter().filter(|d| d.is_default).collect();
        assert!(defaults.len() <= 1, "at most one device can be the OS default");
    }
}
