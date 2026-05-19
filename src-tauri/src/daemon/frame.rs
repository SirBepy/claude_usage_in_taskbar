use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_SIZE: u32 = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("frame size {0} exceeds {MAX_FRAME_SIZE}")]
    TooLarge(u32),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    value: &serde_json::Value,
) -> Result<(), FrameError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_FRAME_SIZE as usize {
        return Err(FrameError::TooLarge(payload.len() as u32));
    }
    let len = (payload.len() as u32).to_be_bytes();
    w.write_all(&len).await?;
    w.write_all(&payload).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin>(
    r: &mut R,
) -> Result<serde_json::Value, FrameError> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME_SIZE {
        return Err(FrameError::TooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    let v = serde_json::from_slice(&payload)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::duplex;

    #[tokio::test]
    async fn roundtrip_small_value() {
        let (mut a, mut b) = duplex(4096);
        let v = json!({"hello": "world", "n": 42});
        write_frame(&mut a, &v).await.expect("write");
        let got = read_frame(&mut b).await.expect("read");
        assert_eq!(got, v);
    }

    #[tokio::test]
    async fn two_frames_back_to_back() {
        let (mut a, mut b) = duplex(4096);
        let v1 = json!({"x": 1});
        let v2 = json!({"x": 2});
        write_frame(&mut a, &v1).await.unwrap();
        write_frame(&mut a, &v2).await.unwrap();
        assert_eq!(read_frame(&mut b).await.unwrap(), v1);
        assert_eq!(read_frame(&mut b).await.unwrap(), v2);
    }

    #[tokio::test]
    async fn oversize_frame_rejected() {
        let (mut a, mut b) = duplex(64);
        // Manually write a 4-byte length larger than MAX_FRAME_SIZE.
        let bogus_len = (MAX_FRAME_SIZE + 1).to_be_bytes();
        a.write_all(&bogus_len).await.unwrap();
        a.shutdown().await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        match err {
            FrameError::TooLarge(_) => {}
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }
}
