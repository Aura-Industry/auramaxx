import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from '@solana/spl-token';

/**
 * Build a native SOL transfer transaction.
 * @param amountLamports - Amount in lamports (1 SOL = 1e9 lamports)
 */
export async function buildSolTransfer(
  connection: Connection,
  from: PublicKey,
  to: PublicKey,
  amountLamports: number | bigint
): Promise<Transaction> {
  const lamports = Number(amountLamports);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    })
  );

  tx.feePayer = from;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  return tx;
}

/**
 * Build an SPL token transfer transaction.
 * Creates the recipient's associated token account if it doesn't exist.
 */
export async function buildSplTransfer(
  connection: Connection,
  from: PublicKey,
  to: PublicKey,
  mint: PublicKey,
  amount: bigint,
  decimals: number
): Promise<Transaction> {
  const tx = new Transaction();

  // Get associated token accounts
  const fromAta = await getAssociatedTokenAddress(mint, from);
  const toAta = await getAssociatedTokenAddress(mint, to);

  // Check if recipient's ATA exists, create if not
  try {
    await getAccount(connection, toAta);
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          from, // payer
          toAta,
          to,
          mint
        )
      );
    } else {
      throw err;
    }
  }

  tx.add(
    createTransferInstruction(
      fromAta,
      toAta,
      from,
      amount
    )
  );

  tx.feePayer = from;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  return tx;
}

/**
 * Sign and send a Solana transaction.
 * Returns the transaction signature.
 */
export async function sendSolanaTransaction(
  connection: Connection,
  tx: Transaction,
  signer: Keypair
): Promise<string> {
  tx.sign(signer);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}
