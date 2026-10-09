//! # Rustls
//!
//! Rustls implementation of tls types

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, StreamOwned};

use super::{TlsConnector, TlsStream};
use crate::{FtpError, FtpResult};

/// A Wrapper for the tls connector
pub struct RustlsConnector {
    connector: Arc<ClientConfig>,
}

impl std::fmt::Debug for RustlsConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<?>")
    }
}

impl From<Arc<ClientConfig>> for RustlsConnector {
    fn from(connector: Arc<ClientConfig>) -> Self {
        Self { connector }
    }
}

impl TlsConnector for RustlsConnector {
    type Stream = RustlsStream;

    fn connect(&self, domain: &str, stream: TcpStream) -> FtpResult<Self::Stream> {
        let server_name = ServerName::try_from(domain.to_string())
            .map_err(|e| FtpError::SecureError(e.to_string()))?;
        let connection = ClientConnection::new(Arc::clone(&self.connector), server_name)
            .map_err(|e| FtpError::SecureError(e.to_string()))?;
        let stream = StreamOwned::new(connection, stream);
        Ok(RustlsStream {
            stream,
            ssl_shutdown: true,
        })
    }
}

// -- tls stream wrapper to implement drop...

/// Tls stream wrapper. This type is a garbage data type used to impl the drop trait for the tls stream.
/// This allows me to keep returning `Read` and `Write` traits in stream methods
#[derive(Debug)]
pub struct RustlsStream {
    stream: StreamOwned<ClientConnection, TcpStream>,
    ssl_shutdown: bool,
}

impl TlsStream for RustlsStream {
    type InnerStream = StreamOwned<ClientConnection, TcpStream>;

    /// Get underlying tcp stream
    fn tcp_stream(mut self) -> TcpStream {
        let mut stream = self.get_ref().try_clone().unwrap();
        // Don't perform shutdown later
        self.ssl_shutdown = false;
        // flush stream (otherwise can cause bad chars on channel)
        if let Err(err) = stream.flush() {
            error!("Error in flushing tcp stream: {}", err);
        }
        trace!("TLS stream terminated");
        stream
    }

    /// Get ref to underlying tcp stream
    fn get_ref(&self) -> &TcpStream {
        self.stream.get_ref()
    }

    /// Get mutable reference to tls stream
    fn mut_ref(&mut self) -> &mut Self::InnerStream {
        &mut self.stream
    }
}

impl Drop for RustlsStream {
    fn drop(&mut self) {
        if self.ssl_shutdown {
            if let Err(err) = self.stream.flush() {
                error!("error in flushing rustls stream on drop: {err}");
            }
            self.stream.conn.send_close_notify();
            if let Err(err) = self.stream.flush() {
                error!("error in terminating rustls stream: {err}");
                return;
            }
            // Closing a Windows socket with unread TLS session tickets can
            // send RST and discard upload bytes still queued in TCP. Half-close
            // the writer, then consume the peer's TLS shutdown before dropping
            // the socket. Bound the wait for peers that never acknowledge it.
            let _ = self.stream.sock.shutdown(Shutdown::Write);
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut buf = [0u8; 1024];
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                if remaining.is_zero() || self.stream.sock.set_read_timeout(Some(remaining)).is_err() {
                    break;
                }
                match self.stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
    }
}
