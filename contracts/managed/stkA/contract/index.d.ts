import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Maybe<T> = { is_some: boolean; value: T };

export type ShieldedCoinInfo = { nonce: Uint8Array;
                                 color: Uint8Array;
                                 value: bigint
                               };

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mints(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  publishMetadata(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, ShieldedCoinInfo>>;
}

export type ProvableCircuits<PS> = {
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mints(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  publishMetadata(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, ShieldedCoinInfo>>;
}

export type PureCircuits = {
  domainSep(): Uint8Array;
  kind(): bigint;
  decimals(): bigint;
}

export type Circuits<PS> = {
  domainSep(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  kind(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  mints(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  publishMetadata(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
       amount_0: bigint,
       nonce_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, ShieldedCoinInfo>>;
}

export type Ledger = {
  readonly _published: boolean;
  readonly _mints: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
