import {
  Currency,
  CurrencyAmount,
  Fraction,
  Percent,
  Price,
  TradeType,
  ONE,
  ZERO,
  Pool,
  Route as V3RouteSDK,
  Trade as V3TradeSDK,
} from "@fairdex/sdk-core";

import invariant from "tiny-invariant";
import { ONE_HUNDRED_PERCENT, ZERO_PERCENT } from "../constants";

import { IRoute, RouteV3 } from "./route";

export class Trade<
  TInput extends Currency,
  TOutput extends Currency,
  TTradeType extends TradeType
> {
  public readonly routes: IRoute<TInput, TOutput, Pool>[];
  public readonly tradeType: TTradeType;
  private _outputAmount: CurrencyAmount<TOutput> | undefined;
  private _inputAmount: CurrencyAmount<TInput> | undefined;

  /**
   * The swaps of the trade, i.e. which routes and how much is swapped in each that
   * make up the trade. May consist of swaps in v2 or v3.
   */
  public readonly swaps: {
    route: IRoute<TInput, TOutput, Pool>;
    inputAmount: CurrencyAmount<TInput>;
    outputAmount: CurrencyAmount<TOutput>;
  }[];

  //  construct a trade across v2 and v3 routes from pre-computed amounts
  public constructor({
    v3Routes,
    tradeType,
  }: {
    v3Routes: {
      routev3: V3RouteSDK<TInput, TOutput>;
      inputAmount: CurrencyAmount<TInput>;
      outputAmount: CurrencyAmount<TOutput>;
    }[];
    tradeType: TTradeType;
  }) {
    this.swaps = [];
    this.routes = [];

    // wrap v3 routes
    for (const { routev3, inputAmount, outputAmount } of v3Routes) {
      const route = new RouteV3(routev3);
      this.routes.push(route);
      this.swaps.push({
        route,
        inputAmount,
        outputAmount,
      });
    }

    if (this.swaps.length === 0) {
      throw new Error("No routes provided when calling Trade constructor");
    }

    this.tradeType = tradeType;

    // each route must have the same input and output currency
    const inputCurrency = this.swaps[0].inputAmount.currency;
    const outputCurrency = this.swaps[0].outputAmount.currency;
    invariant(
      this.swaps.every(({ route }) =>
        inputCurrency.wrapped.equals(route.input.wrapped)
      ),
      "INPUT_CURRENCY_MATCH"
    );
    invariant(
      this.swaps.every(({ route }) =>
        outputCurrency.wrapped.equals(route.output.wrapped)
      ),
      "OUTPUT_CURRENCY_MATCH"
    );

    // pools must be unique inter protocols
    const numPools = this.swaps
      .map(({ route }) => route.pools.length)
      .reduce((total, cur) => total + cur, 0);
    const poolAddressSet = new Set<string>();
    for (const { route } of this.swaps) {
      for (const pool of route.pools) {
        if (pool instanceof Pool) {
          poolAddressSet.add(
            Pool.getAddress(pool.token0, pool.token1, (pool as Pool).fee)
          );
        } else {
          throw new Error(
            "Unexpected pool type in route when constructing trade object"
          );
        }
      }
    }
    invariant(numPools == poolAddressSet.size, "POOLS_DUPLICATED");
  }

  public get inputAmount(): CurrencyAmount<TInput> {
    if (this._inputAmount) {
      return this._inputAmount;
    }

    const inputCurrency = this.swaps[0].inputAmount.currency;
    const totalInputFromRoutes = this.swaps
      .map(({ inputAmount }) => inputAmount)
      .reduce(
        (total, cur) => total.add(cur),
        CurrencyAmount.fromRawAmount(inputCurrency, 0)
      );

    this._inputAmount = totalInputFromRoutes;
    return this._inputAmount;
  }

  public get outputAmount(): CurrencyAmount<TOutput> {
    if (this._outputAmount) {
      return this._outputAmount;
    }

    const outputCurrency = this.swaps[0].outputAmount.currency;
    const totalOutputFromRoutes = this.swaps
      .map(({ outputAmount }) => outputAmount)
      .reduce(
        (total, cur) => total.add(cur),
        CurrencyAmount.fromRawAmount(outputCurrency, 0)
      );

    this._outputAmount = totalOutputFromRoutes;
    return this._outputAmount;
  }

  private _executionPrice: Price<TInput, TOutput> | undefined;

  /**
   * The price expressed in terms of output amount/input amount.
   */
  public get executionPrice(): Price<TInput, TOutput> {
    return (
      this._executionPrice ??
      (this._executionPrice = new Price(
        this.inputAmount.currency,
        this.outputAmount.currency,
        this.inputAmount.quotient,
        this.outputAmount.quotient
      ))
    );
  }

  /**
   * Returns the sell tax of the input token
   */
  public get inputTax(): Percent {
    const inputCurrency = this.inputAmount.currency;
    if (inputCurrency.isNative || !inputCurrency.wrapped.sellFeeBps)
      return ZERO_PERCENT;

    return new Percent(inputCurrency.wrapped.sellFeeBps.toNumber(), 10000);
  }

  /**
   * Returns the buy tax of the output token
   */
  public get outputTax(): Percent {
    const outputCurrency = this.outputAmount.currency;
    if (outputCurrency.isNative || !outputCurrency.wrapped.buyFeeBps)
      return ZERO_PERCENT;

    return new Percent(outputCurrency.wrapped.buyFeeBps.toNumber(), 10000);
  }

  /**
   * The cached result of the price impact computation
   * @private
   */
  private _priceImpact: Percent | undefined;
  /**
   * Returns the percent difference between the route's mid price and the expected execution price
   * In order to exclude token taxes from the price impact calculation, the spot price is calculated
   * using a ratio of values that go into the pools, which are the post-tax input amount and pre-tax output amount.
   */
  public get priceImpact(): Percent {
    if (this._priceImpact) {
      return this._priceImpact;
    }

    // returns 0% price impact even though this may be inaccurate as a swap may have occured.
    // because we're unable to derive the pre-buy-tax amount, use 0% as a placeholder.
    if (this.outputTax.equalTo(ONE_HUNDRED_PERCENT)) return ZERO_PERCENT;

    let spotOutputAmount = CurrencyAmount.fromRawAmount(
      this.outputAmount.currency,
      0
    );
    for (const { route, inputAmount } of this.swaps) {
      const midPrice = route.midPrice;
      const postTaxInputAmount = inputAmount.multiply(
        new Fraction(ONE).subtract(this.inputTax)
      );
      spotOutputAmount = spotOutputAmount.add(
        midPrice.quote(postTaxInputAmount)
      );
    }

    // if the total output of this trade is 0, then most likely the post-tax input was also 0, and therefore this swap
    // does not move the pools' market price
    if (spotOutputAmount.equalTo(ZERO)) return ZERO_PERCENT;

    const preTaxOutputAmount = this.outputAmount.divide(
      new Fraction(ONE).subtract(this.outputTax)
    );
    const priceImpact = spotOutputAmount
      .subtract(preTaxOutputAmount)
      .divide(spotOutputAmount);
    this._priceImpact = new Percent(
      priceImpact.numerator,
      priceImpact.denominator
    );

    return this._priceImpact;
  }

  /**
   * Get the minimum amount that must be received from this trade for the given slippage tolerance
   * @param slippageTolerance The tolerance of unfavorable slippage from the execution price of this trade
   * @returns The amount out
   */
  public minimumAmountOut(
    slippageTolerance: Percent,
    amountOut = this.outputAmount
  ): CurrencyAmount<TOutput> {
    invariant(!slippageTolerance.lessThan(ZERO), "SLIPPAGE_TOLERANCE");
    if (this.tradeType === TradeType.EXACT_OUTPUT) {
      return amountOut;
    } else {
      const slippageAdjustedAmountOut = new Fraction(ONE)
        .add(slippageTolerance)
        .invert()
        .multiply(amountOut.quotient).quotient;
      return CurrencyAmount.fromRawAmount(
        amountOut.currency,
        slippageAdjustedAmountOut
      );
    }
  }

  /**
   * Get the maximum amount in that can be spent via this trade for the given slippage tolerance
   * @param slippageTolerance The tolerance of unfavorable slippage from the execution price of this trade
   * @returns The amount in
   */
  public maximumAmountIn(
    slippageTolerance: Percent,
    amountIn = this.inputAmount
  ): CurrencyAmount<TInput> {
    invariant(!slippageTolerance.lessThan(ZERO), "SLIPPAGE_TOLERANCE");
    if (this.tradeType === TradeType.EXACT_INPUT) {
      return amountIn;
    } else {
      const slippageAdjustedAmountIn = new Fraction(ONE)
        .add(slippageTolerance)
        .multiply(amountIn.quotient).quotient;
      return CurrencyAmount.fromRawAmount(
        amountIn.currency,
        slippageAdjustedAmountIn
      );
    }
  }

  /**
   * Return the execution price after accounting for slippage tolerance
   * @param slippageTolerance the allowed tolerated slippage
   * @returns The execution price
   */
  public worstExecutionPrice(
    slippageTolerance: Percent
  ): Price<TInput, TOutput> {
    return new Price(
      this.inputAmount.currency,
      this.outputAmount.currency,
      this.maximumAmountIn(slippageTolerance).quotient,
      this.minimumAmountOut(slippageTolerance).quotient
    );
  }

  public static async fromRoutes<
    TInput extends Currency,
    TOutput extends Currency,
    TTradeType extends TradeType
  >(
    v3Routes: {
      routev3: V3RouteSDK<TInput, TOutput>;
      amount: TTradeType extends TradeType.EXACT_INPUT
        ? CurrencyAmount<TInput>
        : CurrencyAmount<TOutput>;
    }[],
    tradeType: TTradeType
  ): Promise<Trade<TInput, TOutput, TTradeType>> {
    const populatedV3Routes: {
      routev3: V3RouteSDK<TInput, TOutput>;
      inputAmount: CurrencyAmount<TInput>;
      outputAmount: CurrencyAmount<TOutput>;
    }[] = [];

    for (const { routev3, amount } of v3Routes) {
      const v3Trade = await V3TradeSDK.fromRoute(routev3, amount, tradeType);
      const { inputAmount, outputAmount } = v3Trade;

      populatedV3Routes.push({
        routev3,
        inputAmount,
        outputAmount,
      });
    }

    return new Trade({
      v3Routes: populatedV3Routes,
      tradeType,
    });
  }

  public static async fromRoute<
    TInput extends Currency,
    TOutput extends Currency,
    TTradeType extends TradeType
  >(
    route: V3RouteSDK<TInput, TOutput>,

    amount: TTradeType extends TradeType.EXACT_INPUT
      ? CurrencyAmount<TInput>
      : CurrencyAmount<TOutput>,
    tradeType: TTradeType
  ): Promise<Trade<TInput, TOutput, TTradeType>> {
    let v3Routes: {
      routev3: V3RouteSDK<TInput, TOutput>;
      inputAmount: CurrencyAmount<TInput>;
      outputAmount: CurrencyAmount<TOutput>;
    }[] = [];

    if (route instanceof V3RouteSDK) {
      const v3Trade = await V3TradeSDK.fromRoute(route, amount, tradeType);
      const { inputAmount, outputAmount } = v3Trade;
      v3Routes = [{ routev3: route, inputAmount, outputAmount }];
    } else {
      throw new Error("Invalid route type");
    }

    return new Trade({
      v3Routes,
      tradeType,
    });
  }
}
