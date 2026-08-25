//! Run one federation daemon that watches relay events and publishes acks.
//!
//! Each daemon subscribes to channel messages, tracks DAG state, and emits
//! acknowledgment events that help messages become canonical.

use std::env;
use std::sync::Arc;
use std::time::Duration;

use nostr::{EventId, Filter, Keys, Kind, PublicKey, SecretKey};
use nostr_relay_pool::prelude::*;
use rand::Rng;
use tokio::sync::Mutex;
use tracing::{debug, error, info, trace, warn};

use bitcoin_pages::{create_ack_event, Dag, InsertResult, DAG_EVENT_KIND};

const CHANNEL_MESSAGE_KIND: Kind = Kind::Custom(42);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("federation=info".parse()?)
                .add_directive("nostr_relay_pool=warn".parse()?),
        )
        .init();

    let secret_key = env::var("FEDERATION_KEY")
        .map_err(|_| "FEDERATION_KEY env var required (nsec or hex)")?;
    let keys = parse_keys(&secret_key)?;

    let relay_url = env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:8080".to_string());

    let federation_pubkeys: Vec<PublicKey> = env::var("FEDERATION_PUBKEYS")
        .map_err(|_| "FEDERATION_PUBKEYS env var required (comma-separated hex pubkeys)")?
        .split(',')
        .map(|s| PublicKey::from_hex(s.trim()))
        .collect::<Result<Vec<_>, _>>()?;

    info!(
        pubkey = %keys.public_key(),
        relay = %relay_url,
        federation_size = federation_pubkeys.len(),
        "Starting federation daemon"
    );

    if !federation_pubkeys.contains(&keys.public_key()) {
        warn!("Our pubkey is not in the federation list!");
    }

    let dag = Arc::new(Mutex::new(Dag::new(federation_pubkeys.clone())));
    let pool = RelayPool::default();

    pool.add_relay(&relay_url, RelayOptions::default()).await?;
    pool.connect().await;

    tokio::time::sleep(Duration::from_millis(500)).await;

    let filter = Filter::new()
        .kinds([CHANNEL_MESSAGE_KIND, DAG_EVENT_KIND])
        .limit(1000);

    let sub_id = pool
        .subscribe(filter, SubscribeOptions::default())
        .await?;
    info!(?sub_id, "Subscribed to channel messages and DAG events");

    let dag_clone = dag.clone();
    let keys_clone = keys.clone();
    let pool_clone = pool.clone();

    pool.handle_notifications(move |notification| {
        let dag = dag_clone.clone();
        let keys = keys_clone.clone();
        let pool = pool_clone.clone();

        async move {
            if let RelayPoolNotification::Event { event, .. } = notification {
                handle_event(&dag, &keys, &pool, (*event).clone()).await;
            }
            Ok(false)
        }
    })
    .await?;

    Ok(())
}

async fn handle_event(dag: &Arc<Mutex<Dag>>, keys: &Keys, pool: &RelayPool, event: nostr::Event) {
    let event_id = event.id;
    let event_kind = event.kind;
    let event_author = event.pubkey;
    let is_chat_message = event_kind == CHANNEL_MESSAGE_KIND;

    let mut dag_guard = dag.lock().await;

    match dag_guard.insert(event) {
        InsertResult::Inserted(id) => {
            info!(
                id = %id,
                kind = ?event_kind,
                author = %event_author,
                canonical = dag_guard.is_canonical(id),
                pending = dag_guard.pending_count(),
                "Inserted event"
            );

            if is_chat_message {
                maybe_ack(&mut dag_guard, keys, pool);
            }
        }
        InsertResult::Buffered { missing, .. } => {
            debug!(
                id = %event_id,
                ?missing,
                pending = dag_guard.pending_count(),
                "Buffered event (missing parents)"
            );

            let missing: Vec<EventId> = dag_guard.missing_parents().collect();
            drop(dag_guard);

            fetch_missing(pool, &missing).await;
        }
        InsertResult::Duplicate => {}
    }
}

fn maybe_ack(dag: &mut Dag, keys: &Keys, pool: &RelayPool) {
    let dominated = dag.participants().contains(&keys.public_key());
    if !dominated {
        trace!(pubkey = %keys.public_key(), "skipping ack: not a federation participant");
        return;
    }

    let tips: Vec<EventId> = dag.tips().collect();
    trace!(tip_count = tips.len(), "evaluating ack round");

    let unacked_tips: Vec<EventId> = tips
        .iter()
        .filter(|id| {
            dag.seen_by(**id)
                .map(|s| !s.contains(&keys.public_key()))
                .unwrap_or(true)
        })
        .copied()
        .collect();

    if unacked_tips.is_empty() {
        trace!("skipping ack: all tips already seen");
        return;
    }

    let ack = match create_ack_event(keys, &tips) {
        Ok(ack) => ack,
        Err(e) => {
            error!(?e, "Failed to create ack event");
            return;
        }
    };

    let delay_ms = rand::thread_rng().gen_range(0..10_000);
    let pool = pool.clone();

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        info!(ack_id = %ack.id, delay_ms, "Publishing acknowledgment");
        if let Err(e) = pool.send_event(&ack).await {
            error!(?e, "Failed to publish ack");
        }
    });
}

async fn fetch_missing(pool: &RelayPool, missing: &[EventId]) {
    for id in missing {
        debug!(%id, "Fetching missing event");
        let filter = Filter::new().id(*id);
        if let Err(e) = pool
            .fetch_events(filter, Duration::from_secs(5), ReqExitPolicy::default())
            .await
        {
            debug!(?e, %id, "Failed to fetch missing event");
        }
    }
}

fn parse_keys(s: &str) -> Result<Keys, Box<dyn std::error::Error>> {
    if s.starts_with("nsec") {
        Ok(Keys::parse(s)?)
    } else {
        let sk = SecretKey::from_hex(s)?;
        Ok(Keys::new(sk))
    }
}
