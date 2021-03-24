// tslint:disable: no-unbound-method
import { ChainId, getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import {
    assertRoughlyEquals,
    constants,
    expect,
    getRandomFloat,
    Numberish,
    randomAddress,
} from '@0x/contracts-test-utils';
import { FillQuoteTransformerOrderType, LimitOrder, RfqOrder, SignatureType } from '@0x/protocol-utils';
import { BigNumber, hexUtils, NULL_BYTES } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as _ from 'lodash';
import * as TypeMoq from 'typemoq';

import { MarketOperation, QuoteRequestor, RfqtRequestOpts, SignedNativeOrder } from '../src';
import { NativeOrderWithFillableAmounts } from '../src/types';
import { MarketOperationUtils } from '../src/utils/market_operation_utils/';
import { BalancerPoolsCache } from '../src/utils/market_operation_utils/balancer_utils';
import {
    BUY_SOURCE_FILTER_BY_CHAIN_ID,
    DEFAULT_FEE_SCHEDULE,
    POSITIVE_INF,
    SELL_SOURCE_FILTER_BY_CHAIN_ID,
    SOURCE_FLAGS,
    ZERO_AMOUNT,
} from '../src/utils/market_operation_utils/constants';
import { CreamPoolsCache } from '../src/utils/market_operation_utils/cream_utils';
import { createFills } from '../src/utils/market_operation_utils/fills';
import { findOptimalPath2Async, findOptimalPathAsync } from '../src/utils/market_operation_utils/path_optimizer';
import { DexOrderSampler } from '../src/utils/market_operation_utils/sampler';
import { BATCH_SOURCE_FILTERS } from '../src/utils/market_operation_utils/sampler_operations';
import { SourceFilters } from '../src/utils/market_operation_utils/source_filters';
import {
    AggregationError,
    DexSample,
    ERC20BridgeSource,
    FillData,
    GenerateOptimizedOrdersOpts,
    GetMarketOrdersOpts,
    LiquidityProviderFillData,
    MarketSideLiquidity,
    NativeFillData,
    OptimizedMarketBridgeOrder,
    OptimizerResultWithReport,
    TokenAdjacencyGraph,
} from '../src/utils/market_operation_utils/types';

const MAKER_TOKEN = randomAddress();
const TAKER_TOKEN = randomAddress();

const DEFAULT_EXCLUDED = [
    ERC20BridgeSource.UniswapV2,
    ERC20BridgeSource.Curve,
    ERC20BridgeSource.Balancer,
    ERC20BridgeSource.MStable,
    ERC20BridgeSource.Mooniswap,
    ERC20BridgeSource.Bancor,
    ERC20BridgeSource.Swerve,
    ERC20BridgeSource.SnowSwap,
    ERC20BridgeSource.SushiSwap,
    ERC20BridgeSource.MultiHop,
    ERC20BridgeSource.Shell,
    ERC20BridgeSource.Cream,
    ERC20BridgeSource.Dodo,
    ERC20BridgeSource.DodoV2,
    ERC20BridgeSource.LiquidityProvider,
    ERC20BridgeSource.CryptoCom,
    ERC20BridgeSource.Linkswap,
    ERC20BridgeSource.PancakeSwap,
    ERC20BridgeSource.BakerySwap,
];
const BUY_SOURCES = BUY_SOURCE_FILTER_BY_CHAIN_ID[ChainId.Mainnet].sources;
const SELL_SOURCES = SELL_SOURCE_FILTER_BY_CHAIN_ID[ChainId.Mainnet].sources;
const TOKEN_ADJACENCY_GRAPH: TokenAdjacencyGraph = { default: [] };

const SIGNATURE = { v: 1, r: NULL_BYTES, s: NULL_BYTES, signatureType: SignatureType.EthSign };

/**
 * gets the orders required for a market sell operation by (potentially) merging native orders with
 * generated bridge orders.
 * @param nativeOrders Native orders. Assumes LimitOrders not RfqOrders
 * @param takerAmount Amount of taker asset to sell.
 * @param opts Options object.
 * @return object with optimized orders and a QuoteReport
 */
async function getMarketSellOrdersAsync(
    utils: MarketOperationUtils,
    nativeOrders: SignedNativeOrder[],
    takerAmount: BigNumber,
    opts?: Partial<GetMarketOrdersOpts>,
): Promise<OptimizerResultWithReport> {
    return utils.getOptimizerResultAsync(nativeOrders, takerAmount, MarketOperation.Sell, opts);
}

/**
 * gets the orders required for a market buy operation by (potentially) merging native orders with
 * generated bridge orders.
 * @param nativeOrders Native orders. Assumes LimitOrders not RfqOrders
 * @param makerAmount Amount of maker asset to buy.
 * @param opts Options object.
 * @return object with optimized orders and a QuoteReport
 */
async function getMarketBuyOrdersAsync(
    utils: MarketOperationUtils,
    nativeOrders: SignedNativeOrder[],
    makerAmount: BigNumber,
    opts?: Partial<GetMarketOrdersOpts>,
): Promise<OptimizerResultWithReport> {
    return utils.getOptimizerResultAsync(nativeOrders, makerAmount, MarketOperation.Buy, opts);
}

// tslint:disable: custom-no-magic-numbers promise-function-async
describe('MarketOperationUtils tests', () => {
    const CHAIN_ID = ChainId.Mainnet;
    const contractAddresses = {
        ...getContractAddressesForChainOrThrow(CHAIN_ID),
    };

    function getMockedQuoteRequestor(
        type: 'indicative' | 'firm',
        results: SignedNativeOrder[],
        verifiable: TypeMoq.Times,
    ): TypeMoq.IMock<QuoteRequestor> {
        const args: [any, any, any, any, any, any] = [
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
        ];
        const requestor = TypeMoq.Mock.ofType(QuoteRequestor, TypeMoq.MockBehavior.Loose, true);
        if (type === 'firm') {
            requestor
                .setup(r => r.requestRfqtFirmQuotesAsync(...args))
                .returns(async () => results)
                .verifiable(verifiable);
        } else {
            requestor
                .setup(r => r.requestRfqtIndicativeQuotesAsync(...args))
                .returns(async () => results.map(r => r.order))
                .verifiable(verifiable);
        }
        return requestor;
    }

    function createOrdersFromSellRates(takerAmount: BigNumber, rates: Numberish[]): SignedNativeOrder[] {
        const singleTakerAmount = takerAmount.div(rates.length).integerValue(BigNumber.ROUND_UP);
        return rates.map(r => {
            const o: SignedNativeOrder = {
                order: {
                    ...new LimitOrder({
                        makerAmount: singleTakerAmount.times(r).integerValue(),
                        takerAmount: singleTakerAmount,
                    }),
                },
                signature: SIGNATURE,
                type: FillQuoteTransformerOrderType.Limit,
            };
            return o;
        });
    }

    function createOrdersFromBuyRates(makerAmount: BigNumber, rates: Numberish[]): SignedNativeOrder[] {
        const singleMakerAmount = makerAmount.div(rates.length).integerValue(BigNumber.ROUND_UP);
        return rates.map(r => {
            const o: SignedNativeOrder = {
                order: {
                    ...new LimitOrder({
                        makerAmount: singleMakerAmount,
                        takerAmount: singleMakerAmount.div(r).integerValue(),
                    }),
                },
                signature: SIGNATURE,
                type: FillQuoteTransformerOrderType.Limit,
            };
            return o;
        });
    }

    const ORDER_DOMAIN = {
        exchangeAddress: contractAddresses.exchange,
        chainId: CHAIN_ID,
    };

    function createSamplesFromRates(
        source: ERC20BridgeSource,
        inputs: Numberish[],
        rates: Numberish[],
        fillData?: FillData,
    ): DexSample[] {
        const samples: DexSample[] = [];
        inputs.forEach((input, i) => {
            const rate = rates[i];
            samples.push({
                source,
                fillData: fillData || DEFAULT_FILL_DATA[source],
                input: new BigNumber(input),
                output: new BigNumber(input)
                    .minus(i === 0 ? 0 : samples[i - 1].input)
                    .times(rate)
                    .plus(i === 0 ? 0 : samples[i - 1].output)
                    .integerValue(),
            });
        });
        return samples;
    }

    type GetMultipleQuotesOperation = (
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        fillAmounts: BigNumber[],
        wethAddress: string,
        tokenAdjacencyGraph: TokenAdjacencyGraph,
        liquidityProviderAddress?: string,
    ) => DexSample[][];

    function createGetMultipleSellQuotesOperationFromRates(rates: RatesBySource): GetMultipleQuotesOperation {
        return (
            sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return BATCH_SOURCE_FILTERS.getAllowed(sources).map(s => createSamplesFromRates(s, fillAmounts, rates[s]));
        };
    }

    function createGetMultipleBuyQuotesOperationFromRates(rates: RatesBySource): GetMultipleQuotesOperation {
        return (
            sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return BATCH_SOURCE_FILTERS.getAllowed(sources).map(s =>
                createSamplesFromRates(s, fillAmounts, rates[s].map(r => new BigNumber(1).div(r))),
            );
        };
    }

    type GetMedianRateOperation = (
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        fillAmounts: BigNumber[],
        wethAddress: string,
        liquidityProviderAddress?: string,
    ) => BigNumber;

    function createGetMedianSellRate(rate: Numberish): GetMedianRateOperation {
        return (
            _sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            _fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return new BigNumber(rate);
        };
    }

    function createDecreasingRates(count: number): BigNumber[] {
        const rates: BigNumber[] = [];
        const initialRate = getRandomFloat(1e-3, 1e2);
        _.times(count, () => getRandomFloat(0.95, 1)).forEach((r, i) => {
            const prevRate = i === 0 ? initialRate : rates[i - 1];
            rates.push(prevRate.times(r));
        });
        return rates;
    }

    const NUM_SAMPLES = 3;

    interface RatesBySource {
        [source: string]: Numberish[];
    }

    const ZERO_RATES: RatesBySource = {
        [ERC20BridgeSource.Native]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Eth2Dai]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Uniswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Kyber]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.UniswapV2]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Balancer]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Bancor]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Curve]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.LiquidityProvider]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MStable]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Mooniswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Swerve]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.SnowSwap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.SushiSwap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MultiHop]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Shell]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Cream]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Dodo]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.DodoV2]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.CryptoCom]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Linkswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.PancakeSwap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.BakerySwap]: _.times(NUM_SAMPLES, () => 0),
    };

    const DEFAULT_RATES: RatesBySource = {
        ...ZERO_RATES,
        [ERC20BridgeSource.Native]: createDecreasingRates(NUM_SAMPLES),
        [ERC20BridgeSource.Eth2Dai]: createDecreasingRates(NUM_SAMPLES),
        [ERC20BridgeSource.Uniswap]: createDecreasingRates(NUM_SAMPLES),
    };

    interface FillDataBySource {
        [source: string]: FillData;
    }

    const DEFAULT_FILL_DATA: FillDataBySource = {
        [ERC20BridgeSource.UniswapV2]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Balancer]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Bancor]: { path: [], networkAddress: randomAddress() },
        [ERC20BridgeSource.Kyber]: { hint: '0x', reserveId: '0x', networkAddress: randomAddress() },
        [ERC20BridgeSource.Curve]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.Swerve]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.SnowSwap]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.LiquidityProvider]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.SushiSwap]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Mooniswap]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Native]: { order: new LimitOrder() },
        [ERC20BridgeSource.MultiHop]: {},
        [ERC20BridgeSource.Shell]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Cream]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Dodo]: {},
        [ERC20BridgeSource.DodoV2]: {},
        [ERC20BridgeSource.CryptoCom]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Linkswap]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Uniswap]: { router: randomAddress() },
        [ERC20BridgeSource.Eth2Dai]: { router: randomAddress() },
    };

    const DEFAULT_OPS = {
        getTokenDecimals(_makerAddress: string, _takerAddress: string): BigNumber[] {
            const result = new BigNumber(18);
            return [result, result];
        },
        getLimitOrderFillableTakerAmounts(orders: SignedNativeOrder[]): BigNumber[] {
            return orders.map(o => o.order.takerAmount);
        },
        getLimitOrderFillableMakerAmounts(orders: SignedNativeOrder[]): BigNumber[] {
            return orders.map(o => o.order.makerAmount);
        },
        getSellQuotes: createGetMultipleSellQuotesOperationFromRates(DEFAULT_RATES),
        getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(DEFAULT_RATES),
        getMedianSellRate: createGetMedianSellRate(1),
        getBalancerSellQuotesOffChainAsync: (
            _makerToken: string,
            _takerToken: string,
            takerFillAmounts: BigNumber[],
        ) => [
            createSamplesFromRates(
                ERC20BridgeSource.Balancer,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Balancer],
            ),
        ],
        getBalancerBuyQuotesOffChainAsync: (
            _makerToken: string,
            _takerToken: string,
            makerFillAmounts: BigNumber[],
        ) => [
            createSamplesFromRates(
                ERC20BridgeSource.Balancer,
                makerFillAmounts,
                createDecreasingRates(makerFillAmounts.length).map(r => new BigNumber(1).div(r)),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Balancer],
            ),
        ],
        getCreamSellQuotesOffChainAsync: (_makerToken: string, _takerToken: string, takerFillAmounts: BigNumber[]) => [
            createSamplesFromRates(
                ERC20BridgeSource.Cream,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Cream],
            ),
        ],
        getCreamBuyQuotesOffChainAsync: (_makerToken: string, _takerToken: string, makerFillAmounts: BigNumber[]) => [
            createSamplesFromRates(
                ERC20BridgeSource.Cream,
                makerFillAmounts,
                createDecreasingRates(makerFillAmounts.length).map(r => new BigNumber(1).div(r)),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Cream],
            ),
        ],
        getBancorSellQuotesOffChainAsync: (_makerToken: string, _takerToken: string, takerFillAmounts: BigNumber[]) =>
            createSamplesFromRates(
                ERC20BridgeSource.Bancor,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Bancor],
            ),
        getTwoHopSellQuotes: (..._params: any[]) => [],
        getTwoHopBuyQuotes: (..._params: any[]) => [],
        isAddressContract: (..._params: any[]) => false,
    };

    const MOCK_SAMPLER = ({
        async executeAsync(...ops: any[]): Promise<any[]> {
            return MOCK_SAMPLER.executeBatchAsync(ops);
        },
        async executeBatchAsync(ops: any[]): Promise<any[]> {
            return ops;
        },
        balancerPoolsCache: new BalancerPoolsCache(),
        creamPoolsCache: new CreamPoolsCache(),
        liquidityProviderRegistry: {},
        chainId: CHAIN_ID,
    } as any) as DexOrderSampler;

    function replaceSamplerOps(ops: Partial<typeof DEFAULT_OPS> = {}): void {
        Object.assign(MOCK_SAMPLER, DEFAULT_OPS);
        Object.assign(MOCK_SAMPLER, ops);
    }

    describe('MarketOperationUtils', () => {
        let marketOperationUtils: MarketOperationUtils;

        before(async () => {
            marketOperationUtils = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
        });

        describe('getMarketSellOrdersAsync()', () => {
            const FILL_AMOUNT = new BigNumber('100e18');
            const ORDERS = createOrdersFromSellRates(
                FILL_AMOUNT,
                _.times(NUM_SAMPLES, i => DEFAULT_RATES[ERC20BridgeSource.Native][i]),
            );
            const DEFAULT_OPTS: Partial<GetMarketOrdersOpts> = {
                numSamples: NUM_SAMPLES,
                sampleDistributionBase: 1,
                bridgeSlippage: 0,
                maxFallbackSlippage: 100,
                excludedSources: DEFAULT_EXCLUDED,
                allowFallback: false,
                gasSchedule: {},
                feeSchedule: {},
            };

            beforeEach(() => {
                replaceSamplerOps();
            });

            it('queries `numSamples` samples', async () => {
                const numSamples = _.random(1, NUM_SAMPLES);
                let actualNumSamples = 0;
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        actualNumSamples = amounts.length;
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                });
                await getMarketSellOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    numSamples,
                });
                expect(actualNumSamples).eq(numSamples);
            });

            it('polls all DEXes if `excludedSources` is empty', async () => {
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopSellQuotes: (...args: any[]) => {
                        sourcesPolled.push(ERC20BridgeSource.MultiHop);
                        return DEFAULT_OPS.getTwoHopSellQuotes(...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                    getCreamSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await getMarketSellOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(SELL_SOURCES.slice().sort());
            });

            it('does not poll DEXes in `excludedSources`', async () => {
                const excludedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ...args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                    getCreamSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await getMarketSellOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(_.without(SELL_SOURCES, ...excludedSources).sort());
            });

            it('only polls DEXes in `includedSources`', async () => {
                const includedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ...args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(sources, ...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                    getCreamSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await getMarketSellOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                    includedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(includedSources.sort());
            });

            // // TODO (xianny): v4 will have a new way of representing bridge data
            // it('generates bridge orders with correct asset data', async () => {
            //     const improvedOrdersResponse = await getMarketSellOrdersAsync(
            //         marketOperationUtils,
            //         // Pass in empty orders to prevent native orders from being used.
            //         ORDERS.map(o => ({ ...o, makerAmount: constants.ZERO_AMOUNT })),
            //         FILL_AMOUNT,
            //         DEFAULT_OPTS,
            //     );
            //     const improvedOrders = improvedOrdersResponse.optimizedOrders;
            //     expect(improvedOrders).to.not.be.length(0);
            //     for (const order of improvedOrders) {
            //         expect(getSourceFromAssetData(order.makerAssetData)).to.exist('');
            //         const makerAssetDataPrefix = hexUtils.slice(
            //             assetDataUtils.encodeERC20BridgeAssetData(
            //                 MAKER_TOKEN,
            //                 constants.NULL_ADDRESS,
            //                 constants.NULL_BYTES,
            //             ),
            //             0,
            //             36,
            //         );
            //         assertSamePrefix(order.makerAssetData, makerAssetDataPrefix);
            //         expect(order.takerAssetData).to.eq(TAKER_ASSET_DATA);
            //     }
            // });

            it('getMarketSellOrdersAsync() optimizer will be called once only if price-aware RFQ is disabled', async () => {
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;

                // Ensure that `_generateOptimizedOrdersAsync` is only called once
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.once());

                const totalAssetAmount = ORDERS.map(o => o.order.takerAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getOptimizerResultAsync(
                    ORDERS,
                    totalAssetAmount,
                    MarketOperation.Sell,
                    DEFAULT_OPTS,
                );
                mockedMarketOpUtils.verifyAll();
            });

            it('optimizer will send in a comparison price to RFQ providers', async () => {
                // Set up mocked quote requestor, will return an order that is better
                // than the best of the orders.
                const mockedQuoteRequestor = TypeMoq.Mock.ofType(QuoteRequestor, TypeMoq.MockBehavior.Loose, false, {});

                let requestedComparisonPrice: BigNumber | undefined;

                // to get a comparisonPrice, you need a feeschedule for a native order
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(new BigNumber(1)),
                };
                mockedQuoteRequestor
                    .setup(mqr =>
                        mqr.requestRfqtFirmQuotesAsync(
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                        ),
                    )
                    .callback(
                        (
                            _makerToken: string,
                            _takerToken: string,
                            _assetFillAmount: BigNumber,
                            _marketOperation: MarketOperation,
                            comparisonPrice: BigNumber | undefined,
                            _options: RfqtRequestOpts,
                        ) => {
                            requestedComparisonPrice = comparisonPrice;
                        },
                    )
                    .returns(async () => {
                        return [
                            {
                                order: {
                                    ...new RfqOrder({
                                        makerToken: MAKER_TOKEN,
                                        takerToken: TAKER_TOKEN,
                                        makerAmount: Web3Wrapper.toBaseUnitAmount(321, 6),
                                        takerAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                                    }),
                                },
                                signature: SIGNATURE,
                                type: FillQuoteTransformerOrderType.Rfq,
                            },
                        ];
                    });

                // Set up sampler, will only return 1 on-chain order
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(mou =>
                        mou.getMarketSellLiquidityAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()),
                    )
                    .returns(async () => {
                        return {
                            side: MarketOperation.Sell,
                            inputAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                            inputToken: MAKER_TOKEN,
                            outputToken: TAKER_TOKEN,
                            inputAmountPerEth: Web3Wrapper.toBaseUnitAmount(1, 18),
                            outputAmountPerEth: Web3Wrapper.toBaseUnitAmount(1, 6),
                            quoteSourceFilters: new SourceFilters(),
                            makerTokenDecimals: 6,
                            takerTokenDecimals: 18,
                            quotes: {
                                dexQuotes: [],
                                rfqtIndicativeQuotes: [],
                                twoHopQuotes: [],
                                nativeOrders: [
                                    {
                                        order: new LimitOrder({
                                            makerToken: MAKER_TOKEN,
                                            takerToken: TAKER_TOKEN,
                                            makerAmount: Web3Wrapper.toBaseUnitAmount(320, 6),
                                            takerAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                                        }),
                                        fillableTakerAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                                        fillableMakerAmount: Web3Wrapper.toBaseUnitAmount(320, 6),
                                        fillableTakerFeeAmount: new BigNumber(0),
                                        type: FillQuoteTransformerOrderType.Limit,
                                        signature: SIGNATURE,
                                    },
                                ],
                            },
                            isRfqSupported: true,
                        };
                    });
                const result = await mockedMarketOpUtils.object.getOptimizerResultAsync(
                    ORDERS,
                    Web3Wrapper.toBaseUnitAmount(1, 18),
                    MarketOperation.Sell,
                    {
                        ...DEFAULT_OPTS,
                        feeSchedule,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            txOrigin: randomAddress(),
                            intentOnFilling: true,
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: mockedQuoteRequestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                expect(result.optimizedOrders.length).to.eql(1);
                // tslint:disable-next-line:no-unnecessary-type-assertion
                expect(requestedComparisonPrice!.toString()).to.eql('320');
                expect(result.optimizedOrders[0].makerAmount.toString()).to.eql('321000000');
                expect(result.optimizedOrders[0].takerAmount.toString()).to.eql('1000000000000000000');
            });

            it('getMarketSellOrdersAsync() will not rerun the optimizer if no orders are returned', async () => {
                // Ensure that `_generateOptimizedOrdersAsync` is only called once
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.once());

                const requestor = getMockedQuoteRequestor('firm', [], TypeMoq.Times.once());

                const totalAssetAmount = ORDERS.map(o => o.order.takerAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getOptimizerResultAsync(
                    ORDERS,
                    totalAssetAmount,
                    MarketOperation.Sell,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            intentOnFilling: true,
                            txOrigin: randomAddress(),
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: requestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();
            });

            it('getMarketSellOrdersAsync() will rerun the optimizer if one or more indicative are returned', async () => {
                const requestor = getMockedQuoteRequestor('indicative', [ORDERS[0], ORDERS[1]], TypeMoq.Times.once());

                const numOrdersInCall: number[] = [];
                const numIndicativeQuotesInCall: number[] = [];

                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .callback(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        numOrdersInCall.push(msl.quotes.nativeOrders.length);
                        numIndicativeQuotesInCall.push(msl.quotes.rfqtIndicativeQuotes.length);
                    })
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.exactly(2));

                const totalAssetAmount = ORDERS.map(o => o.order.takerAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getOptimizerResultAsync(
                    ORDERS.slice(2, ORDERS.length),
                    totalAssetAmount,
                    MarketOperation.Sell,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: true,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            txOrigin: randomAddress(),
                            intentOnFilling: true,
                            quoteRequestor: {
                                requestRfqtIndicativeQuotesAsync: requestor.object.requestRfqtIndicativeQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();

                // The first and second optimizer call contains same number of RFQ orders.
                expect(numOrdersInCall.length).to.eql(2);
                expect(numOrdersInCall[0]).to.eql(1);
                expect(numOrdersInCall[1]).to.eql(1);

                // The first call to optimizer will have no RFQ indicative quotes. The second call will have
                // two indicative quotes.
                expect(numIndicativeQuotesInCall.length).to.eql(2);
                expect(numIndicativeQuotesInCall[0]).to.eql(0);
                expect(numIndicativeQuotesInCall[1]).to.eql(2);
            });

            it('getMarketSellOrdersAsync() will rerun the optimizer if one or more RFQ orders are returned', async () => {
                const requestor = getMockedQuoteRequestor('firm', [ORDERS[0]], TypeMoq.Times.once());

                // Ensure that `_generateOptimizedOrdersAsync` is only called once

                // TODO: Ensure fillable amounts increase too
                const numOrdersInCall: number[] = [];
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .callback(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        numOrdersInCall.push(msl.quotes.nativeOrders.length);
                    })
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.exactly(2));

                const totalAssetAmount = ORDERS.map(o => o.order.takerAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getOptimizerResultAsync(
                    ORDERS.slice(1, ORDERS.length),
                    totalAssetAmount,
                    MarketOperation.Sell,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            intentOnFilling: true,
                            txOrigin: randomAddress(),
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: requestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();
                expect(numOrdersInCall.length).to.eql(2);

                // The first call to optimizer was without an RFQ order.
                // The first call to optimizer was with an extra RFQ order.
                expect(numOrdersInCall[0]).to.eql(2);
                expect(numOrdersInCall[1]).to.eql(3);
            });

            it('getMarketSellOrdersAsync() will not raise a NoOptimalPath error if no initial path was found during on-chain DEX optimization, but a path was found after RFQ optimization', async () => {
                let hasFirstOptimizationRun = false;
                let hasSecondOptimizationRun = false;
                const requestor = getMockedQuoteRequestor('firm', [ORDERS[0], ORDERS[1]], TypeMoq.Times.once());

                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        if (msl.quotes.nativeOrders.length === 1) {
                            hasFirstOptimizationRun = true;
                            throw new Error(AggregationError.NoOptimalPath);
                        } else if (msl.quotes.nativeOrders.length === 3) {
                            hasSecondOptimizationRun = true;
                            return mockedMarketOpUtils.target._generateOptimizedOrdersAsync(msl, _opts);
                        } else {
                            throw new Error('Invalid path. this error message should never appear');
                        }
                    })
                    .verifiable(TypeMoq.Times.exactly(2));

                const totalAssetAmount = ORDERS.map(o => o.order.takerAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getOptimizerResultAsync(
                    ORDERS.slice(2, ORDERS.length),
                    totalAssetAmount,
                    MarketOperation.Sell,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            txOrigin: randomAddress(),
                            intentOnFilling: true,
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: requestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();

                expect(hasFirstOptimizationRun).to.eql(true);
                expect(hasSecondOptimizationRun).to.eql(true);
            });

            it('getMarketSellOrdersAsync() will raise a NoOptimalPath error if no path was found during on-chain DEX optimization and RFQ optimization', async () => {
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        throw new Error(AggregationError.NoOptimalPath);
                    })
                    .verifiable(TypeMoq.Times.exactly(1));

                try {
                    await mockedMarketOpUtils.object.getOptimizerResultAsync(
                        ORDERS.slice(2, ORDERS.length),
                        ORDERS[0].order.takerAmount,
                        MarketOperation.Sell,
                        DEFAULT_OPTS,
                    );
                    expect.fail(`Call should have thrown "${AggregationError.NoOptimalPath}" but instead succeded`);
                } catch (e) {
                    if (e.message !== AggregationError.NoOptimalPath) {
                        expect.fail(e);
                    }
                }
                mockedMarketOpUtils.verifyAll();
            });

            it('generates bridge orders with correct taker amount', async () => {
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const totaltakerAmount = BigNumber.sum(...improvedOrders.map(o => o.takerAmount));
                expect(totaltakerAmount).to.bignumber.gte(FILL_AMOUNT);
            });

            it('generates bridge orders with max slippage of `bridgeSlippage`', async () => {
                const bridgeSlippage = _.random(0.1, true);
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, bridgeSlippage },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    const expectedMakerAmount = order.fills[0].output;
                    const slippage = new BigNumber(1).minus(order.makerAmount.div(expectedMakerAmount.plus(1)));
                    assertRoughlyEquals(slippage, bridgeSlippage, 1);
                }
            });

            it('can mix convex sources', async () => {
                const rates: RatesBySource = { ...DEFAULT_RATES };
                rates[ERC20BridgeSource.Native] = [0.4, 0.3, 0.2, 0.1];
                rates[ERC20BridgeSource.Uniswap] = [0.5, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Eth2Dai] = [0.6, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Kyber] = [0, 0, 0, 0]; // unused
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            const ETH_TO_MAKER_RATE = 1.5;

            it('factors in fees for native orders', async () => {
                // Native orders will have the best rates but have fees,
                // dropping their effective rates.
                const nativeFeeRate = 0.06;
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [1, 0.99, 0.98, 0.97], // Effectively [0.94, 0.93, 0.92, 0.91]
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(nativeFeeRate)
                            .dividedToIntegerBy(ETH_TO_MAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('factors in fees for dexes', async () => {
                // Kyber will have the best rates but will have fees,
                // dropping its effective rates.
                const uniswapFeeRate = 0.2;
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.92, 0.1, 0.1, 0.1],
                    // Effectively [0.8, ~0.5, ~0, ~0]
                    [ERC20BridgeSource.Uniswap]: [1, 0.7, 0.2, 0.2],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Uniswap]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(uniswapFeeRate)
                            .dividedToIntegerBy(ETH_TO_MAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('can mix one concave source', async () => {
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Kyber]: [0, 0, 0, 0], // Won't use
                    [ERC20BridgeSource.Eth2Dai]: [0.5, 0.85, 0.75, 0.75], // Concave
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.2, 0.1, 0.1],
                    [ERC20BridgeSource.Native]: [0.95, 0.2, 0.2, 0.1],
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('fallback orders use different sources', async () => {
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.Native] = [0.9, 0.8, 0.5, 0.5];
                rates[ERC20BridgeSource.Uniswap] = [0.6, 0.05, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.4, 0.3, 0.01, 0.01];
                rates[ERC20BridgeSource.Kyber] = [0.35, 0.2, 0.01, 0.01];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = orderSources.slice(0, 4);
                const secondSources = orderSources.slice(4);
                expect(_.intersection(firstSources, secondSources)).to.be.length(0);
            });

            it('does not create a fallback if below maxFallbackSlippage', async () => {
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.Native] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Uniswap] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.49, 0.49, 0.49, 0.49];
                rates[ERC20BridgeSource.Kyber] = [0.35, 0.2, 0.01, 0.01];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await getMarketSellOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true, maxFallbackSlippage: 0.25 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = [ERC20BridgeSource.Native, ERC20BridgeSource.Native, ERC20BridgeSource.Uniswap];
                const secondSources: ERC20BridgeSource[] = [];
                expect(orderSources.slice(0, firstSources.length).sort()).to.deep.eq(firstSources.sort());
                expect(orderSources.slice(firstSources.length).sort()).to.deep.eq(secondSources.sort());
            });

            it('is able to create a order from LiquidityProvider', async () => {
                const liquidityProviderAddress = (DEFAULT_FILL_DATA[ERC20BridgeSource.LiquidityProvider] as any)
                    .poolAddress;
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.LiquidityProvider] = [1, 1, 1, 1];
                MOCK_SAMPLER.liquidityProviderRegistry[liquidityProviderAddress] = {
                    tokens: [MAKER_TOKEN, TAKER_TOKEN],
                    gasCost: 0,
                };
                replaceSamplerOps({
                    getLimitOrderFillableTakerAmounts: () => [constants.ZERO_AMOUNT],
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });

                const sampler = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
                const ordersAndReport = await sampler.getOptimizerResultAsync(
                    [
                        {
                            order: new LimitOrder({
                                makerToken: MAKER_TOKEN,
                                takerToken: TAKER_TOKEN,
                            }),
                            type: FillQuoteTransformerOrderType.Limit,
                            signature: {} as any,
                        },
                    ],
                    FILL_AMOUNT,
                    MarketOperation.Sell,
                    {
                        includedSources: [ERC20BridgeSource.LiquidityProvider],
                        excludedSources: [],
                        numSamples: 4,
                        bridgeSlippage: 0,
                    },
                );
                const result = ordersAndReport.optimizedOrders;
                expect(result.length).to.eql(1);
                expect(
                    (result[0] as OptimizedMarketBridgeOrder<LiquidityProviderFillData>).fillData.poolAddress,
                ).to.eql(liquidityProviderAddress);

                // // TODO (xianny): decode bridge data in v4 format
                // // tslint:disable-next-line:no-unnecessary-type-assertion
                // const decodedAssetData = assetDataUtils.decodeAssetDataOrThrow(
                //     result[0].makerAssetData,
                // ) as ERC20BridgeAssetData;
                // expect(decodedAssetData.assetProxyId).to.eql(AssetProxyId.ERC20Bridge);
                // expect(decodedAssetData.bridgeAddress).to.eql(liquidityProviderAddress);
                // expect(result[0].takerAmount).to.bignumber.eql(FILL_AMOUNT);
            });

            it('factors in exchange proxy gas overhead', async () => {
                // Uniswap has a slightly better rate than LiquidityProvider,
                // but LiquidityProvider is better accounting for the EP gas overhead.
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.01, 0.01, 0.01, 0.01],
                    [ERC20BridgeSource.Uniswap]: [1, 1, 1, 1],
                    [ERC20BridgeSource.LiquidityProvider]: [0.9999, 0.9999, 0.9999, 0.9999],
                };
                MOCK_SAMPLER.liquidityProviderRegistry[randomAddress()] = {
                    tokens: [MAKER_TOKEN, TAKER_TOKEN],
                    gasCost: 0,
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const optimizer = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
                const gasPrice = 100e9; // 100 gwei
                const exchangeProxyOverhead = (sourceFlags: number) =>
                    sourceFlags === SOURCE_FLAGS.LiquidityProvider
                        ? constants.ZERO_AMOUNT
                        : new BigNumber(1.3e5).times(gasPrice);
                const improvedOrdersResponse = await optimizer.getOptimizerResultAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    MarketOperation.Sell,
                    {
                        ...DEFAULT_OPTS,
                        numSamples: 4,
                        includedSources: [
                            ERC20BridgeSource.Native,
                            ERC20BridgeSource.Uniswap,
                            ERC20BridgeSource.LiquidityProvider,
                        ],
                        excludedSources: [],
                        exchangeProxyOverhead,
                    },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [ERC20BridgeSource.LiquidityProvider];
                expect(orderSources).to.deep.eq(expectedSources);
            });
        });

        describe('getMarketBuyOrdersAsync()', () => {
            const FILL_AMOUNT = new BigNumber('100e18');
            const ORDERS = createOrdersFromBuyRates(
                FILL_AMOUNT,
                _.times(NUM_SAMPLES, () => DEFAULT_RATES[ERC20BridgeSource.Native][0]),
            );
            const DEFAULT_OPTS: Partial<GetMarketOrdersOpts> = {
                numSamples: NUM_SAMPLES,
                sampleDistributionBase: 1,
                bridgeSlippage: 0,
                maxFallbackSlippage: 100,
                excludedSources: DEFAULT_EXCLUDED,
                allowFallback: false,
                gasSchedule: {},
                feeSchedule: {},
            };

            beforeEach(() => {
                replaceSamplerOps();
            });

            it('queries `numSamples` samples', async () => {
                const numSamples = _.random(1, 16);
                let actualNumSamples = 0;
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        actualNumSamples = amounts.length;
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                });
                await getMarketBuyOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    numSamples,
                });
                expect(actualNumSamples).eq(numSamples);
            });

            it('polls all DEXes if `excludedSources` is empty', async () => {
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                    getCreamBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await getMarketBuyOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(BUY_SOURCES.sort());
            });

            it('does not poll DEXes in `excludedSources`', async () => {
                const excludedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                    getCreamBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await getMarketBuyOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.eq(_.without(BUY_SOURCES, ...excludedSources).sort());
            });

            it('only polls DEXes in `includedSources`', async () => {
                const includedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                    getCreamBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await getMarketBuyOrdersAsync(marketOperationUtils, ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                    includedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.eq(includedSources.sort());
            });

            // it('generates bridge orders with correct asset data', async () => {
            //     const improvedOrdersResponse = await getMarketBuyOrdersAsync(
            //         marketOperationUtils,
            //         // Pass in empty orders to prevent native orders from being used.
            //         ORDERS.map(o => ({ ...o, makerAmount: constants.ZERO_AMOUNT })),
            //         FILL_AMOUNT,
            //         DEFAULT_OPTS,
            //     );
            //     const improvedOrders = improvedOrdersResponse.optimizedOrders;
            //     expect(improvedOrders).to.not.be.length(0);
            //     for (const order of improvedOrders) {
            //         expect(getSourceFromAssetData(order.makerAssetData)).to.exist('');
            //         const makerAssetDataPrefix = hexUtils.slice(
            //             assetDataUtils.encodeERC20BridgeAssetData(
            //                 MAKER_TOKEN,
            //                 constants.NULL_ADDRESS,
            //                 constants.NULL_BYTES,
            //             ),
            //             0,
            //             36,
            //         );
            //         assertSamePrefix(order.makerAssetData, makerAssetDataPrefix);
            //         expect(order.takerAssetData).to.eq(TAKER_ASSET_DATA);
            //     }
            // });

            it('generates bridge orders with correct maker amount', async () => {
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const totalmakerAmount = BigNumber.sum(...improvedOrders.map(o => o.makerAmount));
                expect(totalmakerAmount).to.bignumber.gte(FILL_AMOUNT);
            });

            it('generates bridge orders with max slippage of `bridgeSlippage`', async () => {
                const bridgeSlippage = _.random(0.1, true);
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, bridgeSlippage },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    const expectedTakerAmount = order.fills[0].output;
                    const slippage = order.takerAmount.div(expectedTakerAmount.plus(1)).minus(1);
                    assertRoughlyEquals(slippage, bridgeSlippage, 1);
                }
            });

            it('can mix convex sources', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [0.4, 0.3, 0.2, 0.1];
                rates[ERC20BridgeSource.Uniswap] = [0.5, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Eth2Dai] = [0.6, 0.05, 0.05, 0.05];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            const ETH_TO_TAKER_RATE = 1.5;

            it('factors in fees for native orders', async () => {
                // Native orders will have the best rates but have fees,
                // dropping their effective rates.
                const nativeFeeRate = 0.06;
                const rates: RatesBySource = {
                    ...ZERO_RATES,
                    [ERC20BridgeSource.Native]: [1, 0.99, 0.98, 0.97], // Effectively [0.94, ~0.93, ~0.92, ~0.91]
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(nativeFeeRate)
                            .dividedToIntegerBy(ETH_TO_TAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('factors in fees for dexes', async () => {
                // Uniswap will have the best rates but will have fees,
                // dropping its effective rates.
                const uniswapFeeRate = 0.2;
                const rates: RatesBySource = {
                    ...ZERO_RATES,
                    [ERC20BridgeSource.Native]: [0.95, 0.1, 0.1, 0.1],
                    // Effectively [0.8, ~0.5, ~0, ~0]
                    [ERC20BridgeSource.Uniswap]: [1, 0.7, 0.2, 0.2],
                    [ERC20BridgeSource.Eth2Dai]: [0.92, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Uniswap]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(uniswapFeeRate)
                            .dividedToIntegerBy(ETH_TO_TAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('fallback orders use different sources', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [0.9, 0.8, 0.5, 0.5];
                rates[ERC20BridgeSource.Uniswap] = [0.6, 0.05, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.4, 0.3, 0.01, 0.01];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = orderSources.slice(0, 4);
                const secondSources = orderSources.slice(4);
                expect(_.intersection(firstSources, secondSources)).to.be.length(0);
            });

            it('does not create a fallback if below maxFallbackSlippage', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Uniswap] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.49, 0.49, 0.49, 0.49];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await getMarketBuyOrdersAsync(
                    marketOperationUtils,
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true, maxFallbackSlippage: 0.25 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = [ERC20BridgeSource.Native, ERC20BridgeSource.Native, ERC20BridgeSource.Uniswap];
                const secondSources: ERC20BridgeSource[] = [];
                expect(orderSources.slice(0, firstSources.length).sort()).to.deep.eq(firstSources.sort());
                expect(orderSources.slice(firstSources.length).sort()).to.deep.eq(secondSources.sort());
            });

            it('factors in exchange proxy gas overhead', async () => {
                // Uniswap has a slightly better rate than LiquidityProvider,
                // but LiquidityProvider is better accounting for the EP gas overhead.
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.01, 0.01, 0.01, 0.01],
                    [ERC20BridgeSource.Uniswap]: [1, 1, 1, 1],
                    [ERC20BridgeSource.LiquidityProvider]: [0.9999, 0.9999, 0.9999, 0.9999],
                };
                MOCK_SAMPLER.liquidityProviderRegistry[randomAddress()] = {
                    tokens: [MAKER_TOKEN, TAKER_TOKEN],
                    gasCost: 0,
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const optimizer = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
                const gasPrice = 100e9; // 100 gwei
                const exchangeProxyOverhead = (sourceFlags: number) =>
                    sourceFlags === SOURCE_FLAGS.LiquidityProvider
                        ? constants.ZERO_AMOUNT
                        : new BigNumber(1.3e5).times(gasPrice);
                const improvedOrdersResponse = await optimizer.getOptimizerResultAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    MarketOperation.Buy,
                    {
                        ...DEFAULT_OPTS,
                        numSamples: 4,
                        includedSources: [
                            ERC20BridgeSource.Native,
                            ERC20BridgeSource.Uniswap,
                            ERC20BridgeSource.LiquidityProvider,
                        ],
                        excludedSources: [],
                        exchangeProxyOverhead,
                    },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [ERC20BridgeSource.LiquidityProvider];
                expect(orderSources).to.deep.eq(expectedSources);
            });
        });
    });

    describe('createFills', () => {
        const takerAmount = new BigNumber(5000000);
        const outputAmountPerEth = new BigNumber(0.5);
        // tslint:disable-next-line:no-object-literal-type-assertion
        const smallOrder: NativeOrderWithFillableAmounts = {
            order: {
                ...new LimitOrder({
                    chainId: 1,
                    maker: 'SMALL_ORDER',
                    takerAmount,
                    makerAmount: takerAmount.times(2),
                }),
            },
            fillableMakerAmount: takerAmount.times(2),
            fillableTakerAmount: takerAmount,
            fillableTakerFeeAmount: new BigNumber(0),
            type: FillQuoteTransformerOrderType.Limit,
            signature: SIGNATURE,
        };
        const largeOrder: NativeOrderWithFillableAmounts = {
            order: {
                ...new LimitOrder({
                    chainId: 1,
                    maker: 'LARGE_ORDER',
                    takerAmount: smallOrder.order.takerAmount.times(2),
                    makerAmount: smallOrder.order.makerAmount.times(2),
                }),
            },
            fillableTakerAmount: smallOrder.fillableTakerAmount.times(2),
            fillableMakerAmount: smallOrder.fillableMakerAmount.times(2),
            fillableTakerFeeAmount: new BigNumber(0),
            type: FillQuoteTransformerOrderType.Limit,
            signature: SIGNATURE,
        };
        const orders = [smallOrder, largeOrder];
        const feeSchedule = {
            [ERC20BridgeSource.Native]: _.constant(2e5),
        };

        it('penalizes native fill based on target amount when target is smaller', () => {
            const path = createFills({
                side: MarketOperation.Sell,
                orders,
                dexQuotes: [],
                targetInput: takerAmount.minus(1),
                outputAmountPerEth,
                feeSchedule,
            });
            expect((path[0][0].fillData as NativeFillData).order.maker).to.eq(smallOrder.order.maker);
            expect(path[0][0].input).to.be.bignumber.eq(takerAmount.minus(1));
        });

        it('penalizes native fill based on available amount when target is larger', () => {
            const path = createFills({
                side: MarketOperation.Sell,
                orders,
                dexQuotes: [],
                targetInput: POSITIVE_INF,
                outputAmountPerEth,
                feeSchedule,
            });
            expect((path[0][0].fillData as NativeFillData).order.maker).to.eq(largeOrder.order.maker);
            expect((path[0][1].fillData as NativeFillData).order.maker).to.eq(smallOrder.order.maker);
        });
    });

    describe.only('optimization', () => {
        const DEX_QUOTES_1 = [
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['16936729550319', '4320812658856612'],
                    ['34720295578153', '8857665905159678'],
                    ['53393039907379', '13621361763618486'],
                    ['72999421453066', '18623242359699323'],
                    ['93586122076038', '23875216924615198'],
                    ['115202157730158', '29389790150558206'],
                    ['137898995166984', '35180091963689961'],
                    ['161730674475652', '41259908785773968'],
                    ['186753937749752', '47643716358882595'],
                    ['213028364187558', '54346714211334566'],
                    ['240616511947254', '61384861846917204'],
                    ['269584067094935', '68774916743564257'],
                    ['300000000000000', '76534474251955622'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['16936729550319', '1514725'],
                    ['34720295578153', '1514725'],
                    ['53393039907379', '1514725'],
                    ['72999421453066', '1514725'],
                    ['93586122076038', '1514725'],
                    ['115202157730158', '1514725'],
                    ['137898995166984', '1514725'],
                    ['161730674475652', '1514725'],
                    ['186753937749752', '1514725'],
                    ['213028364187558', '1514725'],
                    ['240616511947254', '1514725'],
                    ['269584067094935', '1514725'],
                    ['300000000000000', '1514725'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['16936729550319', '42106'],
                    ['34720295578153', '42106'],
                    ['53393039907379', '42106'],
                    ['72999421453066', '42106'],
                    ['93586122076038', '42106'],
                    ['115202157730158', '42106'],
                    ['137898995166984', '42106'],
                    ['161730674475652', '42106'],
                    ['186753937749752', '42106'],
                    ['213028364187558', '42106'],
                    ['240616511947254', '42106'],
                    ['269584067094935', '42106'],
                    ['300000000000000', '42106'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['16936729550319', '4305662236192433'],
                    ['34720295578153', '8826546518212012'],
                    ['53393039907379', '13573407690485679'],
                    ['72999421453066', '18557537698450501'],
                    ['93586122076038', '23790792377915673'],
                    ['115202157730158', '29285619577163099'],
                    ['137898995166984', '35055088677738584'],
                    ['161730674475652', '41112921583105510'],
                    ['186753937749752', '47473525247718449'],
                    ['213028364187558', '54152025822618181'],
                    ['240616511947254', '61164304497350851'],
                    ['269584067094935', '68527035121914166'],
                    ['300000000000000', '76257723696491075'],
                ],
            },
            {
                source: 'DODO',
                inputOutputs: [
                    ['16936729550319', '4329705102225823'],
                    ['34720295578153', '8875895453964064'],
                    ['53393039907379', '13649395317116795'],
                    ['72999421453066', '18661570166621898'],
                    ['93586122076038', '23924353751099688'],
                    ['115202157730158', '29450276506529441'],
                    ['137898995166984', '35252495390611032'],
                    ['161730674475652', '41344825208842456'],
                    ['186753937749752', '47741771506900065'],
                    ['213028364187558', '54458565107639545'],
                    ['240616511947254', '61511198374941950'],
                    ['269584067094935', '68916463290754440'],
                    ['300000000000000', '76691991435979778'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['16936729550319', '4331121798315007'],
                    ['34720295578153', '8878799686484748'],
                    ['53393039907379', '13653861468996054'],
                    ['72999421453066', '18667676340558981'],
                    ['93586122076038', '23932181955618781'],
                    ['115202157730158', '29459912851341627'],
                    ['137898995166984', '35264030291751627'],
                    ['161730674475652', '41358353604073169'],
                    ['186753937749752', '47757393081890105'],
                    ['213028364187558', '54476384533465485'],
                    ['240616511947254', '61531325557473300'],
                    ['269584067094935', '68939013632520310'],
                    ['300000000000000', '76717086111141880'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['16936729550319', '4300481346410902'],
                    ['34720295578153', '8815980848467036'],
                    ['53393039907379', '13557248808011948'],
                    ['72999421453066', '18535572979874643'],
                    ['93586122076038', '23762805438151657'],
                    ['115202157730158', '29251390785153046'],
                    ['137898995166984', '35014395770075547'],
                    ['161730674475652', '41065540387815690'],
                    ['186753937749752', '47419230531849837'],
                    ['213028364187558', '54090592278795478'],
                    ['240616511947254', '61095507886134346'],
                    ['269584067094935', '68450653588654010'],
                    ['300000000000000', '76173539283417404'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['16936729550319', '4335169991371183'],
                    ['34720295578153', '8887098482064212'],
                    ['53393039907379', '13666623397020238'],
                    ['72999421453066', '18685124557424402'],
                    ['93586122076038', '23954550775518649'],
                    ['115202157730158', '29487448304153306'],
                    ['137898995166984', '35296990708818224'],
                    ['161730674475652', '41397010233273942'],
                    ['186753937749752', '47802030733464096'],
                    ['213028364187558', '54527302258126001'],
                    ['240616511947254', '61588837358427766'],
                    ['269584067094935', '69003449213090713'],
                    ['300000000000000', '76788791659765808'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['16936729550319', '4314475943065645'],
                    ['34720295578153', '8844675288860630'],
                    ['53393039907379', '13601384167093368'],
                    ['72999421453066', '18595928009813325'],
                    ['93586122076038', '23840198516104187'],
                    ['115202157730158', '29346681964966331'],
                    ['137898995166984', '35128488943797412'],
                    ['161730674475652', '41199385563242572'],
                    ['186753937749752', '47573826232728535'],
                    ['213028364187558', '54266988074712679'],
                    ['240616511947254', '61294807059569691'],
                    ['269584067094935', '68674015947147866'],
                    ['300000000000000', '76422184125314974'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['16936729550319', '4313078308254689'],
                    ['34720295578153', '8841809793962217'],
                    ['53393039907379', '13596977040354882'],
                    ['72999421453066', '18589901752072993'],
                    ['93586122076038', '23832471710441441'],
                    ['115202157730158', '29337169076426828'],
                    ['137898995166984', '35117100108654632'],
                    ['161730674475652', '41186026367226750'],
                    ['186753937749752', '47558397477620459'],
                    ['213028364187558', '54249385532664587'],
                    ['240616511947254', '61274921214477853'],
                    ['269584067094935', '68651731722361348'],
                    ['300000000000000', '76397380596922300'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['16936729550319', '4311335047708650'],
                    ['34720295578153', '8838236760057372'],
                    ['53393039907379', '13591483461282375'],
                    ['72999421453066', '18582392390915397'],
                    ['93586122076038', '23822846649440113'],
                    ['115202157730158', '29325323491251274'],
                    ['137898995166984', '35102924032225175'],
                    ['161730674475652', '41169404442667907'],
                    ['186753937749752', '47539208699900798'],
                    ['213028364187558', '54227502978457898'],
                    ['240616511947254', '61250211759773149'],
                    ['269584067094935', '68624055747336713'],
                    ['300000000000000', '76366591677599186'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['16936729550319', '4314375821490409'],
                    ['34720295578153', '8844470432247229'],
                    ['53393039907379', '13601069771548789'],
                    ['72999421453066', '18595499075617874'],
                    ['93586122076038', '23839649842467860'],
                    ['115202157730158', '29346008144989145'],
                    ['137898995166984', '35127684359691665'],
                    ['161730674475652', '41198444381882816'],
                    ['186753937749752', '47572742401603709'],
                    ['213028364187558', '54265755318364548'],
                    ['240616511947254', '61293418876612498'],
                    ['269584067094935', '68672465607976081'],
                    ['300000000000000', '76420464670619338'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['16936729550319', '4340018616431734'],
                    ['34720295578153', '8897030353989107'],
                    ['53393039907379', '13681884068257604'],
                    ['72999421453066', '18705970975556794'],
                    ['93586122076038', '23981251762568893'],
                    ['115202157730158', '29520285050585077'],
                    ['137898995166984', '35336257282015950'],
                    ['161730674475652', '41443014100178523'],
                    ['186753937749752', '47855093296917348'],
                    ['213028364187558', '54587759406336091'],
                    ['240616511947254', '61657040026807972'],
                    ['269584067094935', '69079763957542674'],
                    ['300000000000000', '76873601240273360'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['16936729550319', '16057'],
                    ['34720295578153', '16057'],
                    ['53393039907379', '16057'],
                    ['72999421453066', '16057'],
                    ['93586122076038', '16057'],
                    ['115202157730158', '16057'],
                    ['137898995166984', '16057'],
                    ['161730674475652', '16057'],
                    ['186753937749752', '16057'],
                    ['213028364187558', '16057'],
                    ['240616511947254', '16057'],
                    ['269584067094935', '16057'],
                    ['300000000000000', '16057'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['16936729550319', '0'],
                    ['34720295578153', '0'],
                    ['53393039907379', '0'],
                    ['72999421453066', '0'],
                    ['93586122076038', '0'],
                    ['115202157730158', '0'],
                    ['137898995166984', '0'],
                    ['161730674475652', '0'],
                    ['186753937749752', '0'],
                    ['213028364187558', '0'],
                    ['240616511947254', '0'],
                    ['269584067094935', '0'],
                    ['300000000000000', '0'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['16936729550319', '4324891654231059'],
                    ['34720295578153', '8865831028986812'],
                    ['53393039907379', '13633600346388394'],
                    ['72999421453066', '18639518875141319'],
                    ['93586122076038', '23895469571611070'],
                    ['115202157730158', '29413927031353533'],
                    ['137898995166984', '35207986814422078'],
                    ['161730674475652', '41291396210707191'],
                    ['186753937749752', '47678586514634715'],
                    ['213028364187558', '54384706881744187'],
                    ['240616511947254', '61425659842985308'],
                    ['269584067094935', '68818138556045893'],
                    ['300000000000000', '76579665876613268'],
                ],
            },
        ];
        const DEX_QUOTES_2 = [
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['28227882583863829016150352', '3346753595337885517137'],
                    ['57867159296920849483108221', '3399754052327250313997'],
                    ['88988399845630720973413984', '3417781505446250879321'],
                    ['121665702421776086038235035', '3426856284515826542992'],
                    ['155976870126728719356297138', '3432315641329748161190'],
                    ['192003596216928984340262347', '3435957654359492055647'],
                    ['229831658611639262573425816', '3438557635712583557540'],
                    ['269551124126085054718247458', '3440504797836312657806'],
                    ['311256562916253136470310183', '3442015988706333605286'],
                    ['355047273645929622309976043', '3443221597456354794367'],
                    ['401027519912089932441625197', '3444204739135637654232'],
                    ['449306778491558258079856808', '3445020899510542657930'],
                    ['500000000000000000000000000', '3445708535431735198045'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['28227882583863829016150352', '163'],
                    ['57867159296920849483108221', '163'],
                    ['88988399845630720973413984', '163'],
                    ['121665702421776086038235035', '163'],
                    ['155976870126728719356297138', '163'],
                    ['192003596216928984340262347', '163'],
                    ['229831658611639262573425816', '163'],
                    ['269551124126085054718247458', '163'],
                    ['311256562916253136470310183', '163'],
                    ['355047273645929622309976043', '163'],
                    ['401027519912089932441625197', '163'],
                    ['449306778491558258079856808', '163'],
                    ['500000000000000000000000000', '163'],
                ],
            },
            {
                source: 'BakerySwap',
                inputOutputs: [
                    ['28227882583863829016150352', '2543981654454232001'],
                    ['57867159296920849483108221', '2544012316692096090'],
                    ['88988399845630720973413984', '2544022529496870471'],
                    ['121665702421776086038235035', '2544027629858135965'],
                    ['155976870126728719356297138', '2544030685235285438'],
                    ['192003596216928984340262347', '2544032718124907156'],
                    ['229831658611639262573425816', '2544034166743457669'],
                    ['269551124126085054718247458', '2544035250201230026'],
                    ['311256562916253136470310183', '2544036090227660106'],
                    ['355047273645929622309976043', '2544036759861623473'],
                    ['401027519912089932441625197', '2544037305583445110'],
                    ['449306778491558258079856808', '2544037758380925090'],
                    ['500000000000000000000000000', '2544038139707975997'],
                ],
            },
            {
                source: 'DODO',
                inputOutputs: [
                    ['28227882583863829016150352', '260096020481352007900'],
                    ['57867159296920849483108221', '260096029913997804252'],
                    ['88988399845630720973413984', '260096033050648240117'],
                    ['121665702421776086038235035', '260096034616161531012'],
                    ['155976870126728719356297138', '260096035553679070400'],
                    ['192003596216928984340262347', '260096036177328120559'],
                    ['229831658611639262573425816', '260096036621673049689'],
                    ['269551124126085054718247458', '260096036953976106710'],
                    ['311256562916253136470310183', '260096037211597543075'],
                    ['355047273645929622309976043', '260096037416950227319'],
                    ['401027519912089932441625197', '260096037584295401110'],
                    ['449306778491558258079856808', '260096037723139871220'],
                    ['500000000000000000000000000', '260096037840064974333'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829016150352', '203718481208606640375'],
                    ['57867159296920849483108221', '203718483178298293255'],
                    ['88988399845630720973413984', '203718483833512891068'],
                    ['121665702421776086038235035', '203718484160575838020'],
                    ['155976870126728719356297138', '203718484356453272812'],
                    ['192003596216928984340262347', '203718484486759222421'],
                    ['229831658611639262573425816', '203718484579603937729'],
                    ['269551124126085054718247458', '203718484649039304920'],
                    ['311256562916253136470310183', '203718484702870691597'],
                    ['355047273645929622309976043', '203718484745780796977'],
                    ['401027519912089932441625197', '203718484780749290170'],
                    ['449306778491558258079856808', '203718484809762517160'],
                    ['500000000000000000000000000', '203718484834195602885'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '94094647532813050895631'],
                    ['57867159296920849483108221', '167265469975511715665673'],
                    ['88988399845630720973413984', '225730733834528496100763'],
                    ['121665702421776086038235035', '273467185558492456707344'],
                    ['155976870126728719356297138', '313136597708148968894736'],
                    ['192003596216928984340262347', '346587815965874509778420'],
                    ['229831658611639262573425816', '375145109734790273454873'],
                    ['269551124126085054718247458', '399781916562154438751476'],
                    ['311256562916253136470310183', '421229821272509087709845'],
                    ['355047273645929622309976043', '440049287987769346757065'],
                    ['401027519912089932441625197', '456676939936729630965077'],
                    ['449306778491558258079856808', '471457983869441559984082'],
                    ['500000000000000000000000000', '484668953607929018744662'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '397402455249772608902'],
                    ['57867159296920849483108221', '398139645053733805527'],
                    ['88988399845630720973413984', '398385787671121927772'],
                    ['121665702421776086038235035', '398508826624777727447'],
                    ['155976870126728719356297138', '398582569419084952040'],
                    ['192003596216928984340262347', '398631649076778212922'],
                    ['229831658611639262573425816', '398666630119994057434'],
                    ['269551124126085054718247458', '398692797297800627625'],
                    ['311256562916253136470310183', '398713087581745232006'],
                    ['355047273645929622309976043', '398729263617929832920'],
                    ['401027519912089932441625197', '398742447330572506724'],
                    ['449306778491558258079856808', '398753386806401488283'],
                    ['500000000000000000000000000', '398762600036828450351'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '212289092105429995722'],
                    ['57867159296920849483108221', '212498746245175195669'],
                    ['88988399845630720973413984', '212568667500456744492'],
                    ['121665702421776086038235035', '212603603788606105944'],
                    ['155976870126728719356297138', '212624537844943623515'],
                    ['192003596216928984340262347', '212638468537455214106'],
                    ['229831658611639262573425816', '212648396521834044685'],
                    ['269551124126085054718247458', '212655822506402648377'],
                    ['311256562916253136470310183', '212661580373018816873'],
                    ['355047273645929622309976043', '212666170524276537235'],
                    ['401027519912089932441625197', '212669911437638259315'],
                    ['449306778491558258079856808', '212673015454979236995'],
                    ['500000000000000000000000000', '212675629597654715431'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '1749552968940125562882'],
                    ['57867159296920849483108221', '1763952721028185525424'],
                    ['88988399845630720973413984', '1768801598898146696208'],
                    ['121665702421776086038235035', '1771233149608137260461'],
                    ['155976870126728719356297138', '1772692972693802519645'],
                    ['192003596216928984340262347', '1773665595259331209104'],
                    ['229831658611639262573425816', '1774359327760296761746'],
                    ['269551124126085054718247458', '1774878541830877060058'],
                    ['311256562916253136470310183', '1775281307729423981844'],
                    ['355047273645929622309976043', '1775602506642824129364'],
                    ['401027519912089932441625197', '1775864355279679916836'],
                    ['449306778491558258079856808', '1776081675437602800851'],
                    ['500000000000000000000000000', '1776264734564392820461'],
                ],
            },
            {
                source: 'PancakeSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '48077122853824549770859'],
                    ['57867159296920849483108221', '61955835996683443314993'],
                    ['88988399845630720973413984', '68546517571938736954988'],
                    ['121665702421776086038235035', '72392384794391990762243'],
                    ['155976870126728719356297138', '74910130952022526867201'],
                    ['192003596216928984340262347', '76684628819488377233923'],
                    ['229831658611639262573425816', '78001297181015028730135'],
                    ['269551124126085054718247458', '79016004186580360174645'],
                    ['311256562916253136470310183', '79821080536670369281445'],
                    ['355047273645929622309976043', '80474701001207182522012'],
                    ['401027519912089932441625197', '81015341964536944871919'],
                    ['449306778491558258079856808', '81469468595454739240923'],
                    ['500000000000000000000000000', '81855882787709066601024'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '20146631550715476363'],
                    ['57867159296920849483108221', '20148541874580720562'],
                    ['88988399845630720973413984', '20149178224655454841'],
                    ['121665702421776086038235035', '20149496036413106686'],
                    ['155976870126728719356297138', '20149686426095316751'],
                    ['192003596216928984340262347', '20149813103263587472'],
                    ['229831658611639262573425816', '20149903373103409316'],
                    ['269551124126085054718247458', '20149970888618826933'],
                    ['311256562916253136470310183', '20150023235016929436'],
                    ['355047273645929622309976043', '20150064963547873496'],
                    ['401027519912089932441625197', '20150098970551518640'],
                    ['449306778491558258079856808', '20150127186991558030'],
                    ['500000000000000000000000000', '20150150949747692743'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '62'],
                    ['57867159296920849483108221', '62'],
                    ['88988399845630720973413984', '62'],
                    ['121665702421776086038235035', '62'],
                    ['155976870126728719356297138', '62'],
                    ['192003596216928984340262347', '62'],
                    ['229831658611639262573425816', '62'],
                    ['269551124126085054718247458', '62'],
                    ['311256562916253136470310183', '62'],
                    ['355047273645929622309976043', '62'],
                    ['401027519912089932441625197', '62'],
                    ['449306778491558258079856808', '62'],
                    ['500000000000000000000000000', '62'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '0'],
                    ['57867159296920849483108221', '0'],
                    ['88988399845630720973413984', '0'],
                    ['121665702421776086038235035', '0'],
                    ['155976870126728719356297138', '0'],
                    ['192003596216928984340262347', '0'],
                    ['229831658611639262573425816', '0'],
                    ['269551124126085054718247458', '0'],
                    ['311256562916253136470310183', '0'],
                    ['355047273645929622309976043', '0'],
                    ['401027519912089932441625197', '0'],
                    ['449306778491558258079856808', '0'],
                    ['500000000000000000000000000', '0'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829016150352', '767549075073628415'],
                    ['57867159296920849483108221', '767551944218806639'],
                    ['88988399845630720973413984', '767552899846863493'],
                    ['121665702421776086038235035', '767553377093632992'],
                    ['155976870126728719356297138', '767553662988214458'],
                    ['192003596216928984340262347', '767553853207391083'],
                    ['229831658611639262573425816', '767553988755708529'],
                    ['269551124126085054718247458', '767554090135590194'],
                    ['311256562916253136470310183', '767554168737394372'],
                    ['355047273645929622309976043', '767554231395442057'],
                    ['401027519912089932441625197', '767554282458940213'],
                    ['449306778491558258079856808', '767554324827443921'],
                    ['500000000000000000000000000', '767554360508413074'],
                ],
            },
        ];

        const DEX_QUOTES_3 = [
            {
                source: 'Uniswap',
                inputOutputs: [
                    ['56455765167727658032301', '43263993345'],
                    ['115734318593841698966217', '71934984017'],
                    ['177976799691261441946828', '92310065804'],
                    ['243331404843552172076471', '107518956742'],
                    ['311953740253457438712595', '119293009432'],
                    ['384007192433857968680525', '128667738021'],
                    ['459663317223278525146852', '136300483005'],
                    ['539102248252170109436495', '142628610988'],
                    ['622513125832506272940621', '147954430783'],
                    ['710094547291859244619953', '152493592707'],
                    ['802055039824179864883251', '156404066507'],
                    ['898613556983116516159714', '159804220124'],
                    ['1000000000000000000000000', '162784499782'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['56455765167727658032301', '56077158255'],
                    ['115734318593841698966217', '114429370088'],
                    ['177976799691261441946828', '175124198858'],
                    ['243331404843552172076471', '238228941318'],
                    ['311953740253457438712595', '303810380097'],
                    ['384007192433857968680525', '371934516007'],
                    ['459663317223278525146852', '442666279946'],
                    ['539102248252170109436495', '516069224366'],
                    ['622513125832506272940621', '592205194433'],
                    ['710094547291859244619953', '671133979266'],
                    ['802055039824179864883251', '752912943862'],
                    ['898613556983116516159714', '837596642603'],
                    ['1000000000000000000000000', '925236415532'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['56455765167727658032301', '55880458520'],
                    ['115734318593841698966217', '114370718644'],
                    ['177976799691261441946828', '175583366755'],
                    ['243331404843552172076471', '239634930284'],
                    ['311953740253457438712595', '306645923333'],
                    ['384007192433857968680525', '376740882153'],
                    ['459663317223278525146852', '450048389131'],
                    ['539102248252170109436495', '526701083823'],
                    ['622513125832506272940621', '606835659482'],
                    ['710094547291859244619953', '690592843434'],
                    ['802055039824179864883251', '778117359536'],
                    ['898613556983116516159714', '869557870857'],
                    ['1000000000000000000000000', '965066900643'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['56455765167727658032301', '55483928764'],
                    ['115734318593841698966217', '112508817322'],
                    ['177976799691261441946828', '171069069181'],
                    ['243331404843552172076471', '231155031685'],
                    ['311953740253457438712595', '292752818832'],
                    ['384007192433857968680525', '355844150519'],
                    ['459663317223278525146852', '420406210886'],
                    ['539102248252170109436495', '486411528445'],
                    ['622513125832506272940621', '553827880570'],
                    ['710094547291859244619953', '622618224828'],
                    ['802055039824179864883251', '692740659510'],
                    ['898613556983116516159714', '764148415445'],
                    ['1000000000000000000000000', '836789880962'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['56455765167727658032301', '34228194925'],
                    ['115734318593841698966217', '49936220418'],
                    ['177976799691261441946828', '58946293295'],
                    ['243331404843552172076471', '64783873060'],
                    ['311953740253457438712595', '68869570687'],
                    ['384007192433857968680525', '71885989657'],
                    ['459663317223278525146852', '74201884835'],
                    ['539102248252170109436495', '76033944324'],
                    ['622513125832506272940621', '77517853074'],
                    ['710094547291859244619953', '78742907111'],
                    ['802055039824179864883251', '79770280505'],
                    ['898613556983116516159714', '80643286932'],
                    ['1000000000000000000000000', '81393456567'],
                ],
            },
            {
                source: 'Eth2Dai',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['56455765167727658032301', '56125640125'],
                    ['115734318593841698966217', '114965497799'],
                    ['177976799691261441946828', '176759117884'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['56455765167727658032301', '56076664202'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Curve',
                inputOutputs: [
                    ['56455765167727658032301', '56492508747'],
                    ['115734318593841698966217', '115809366144'],
                    ['177976799691261441946828', '178091761875'],
                    ['243331404843552172076471', '243487942358'],
                    ['311953740253457438712595', '312153563312'],
                    ['384007192433857968680525', '384252059930'],
                    ['459663317223278525146852', '459955035534'],
                    ['539102248252170109436495', '539442669626'],
                    ['622513125832506272940621', '622904146313'],
                    ['710094547291859244619953', '710538104119'],
                    ['802055039824179864883251', '802553108242'],
                    ['898613556983116516159714', '899168146389'],
                    ['1000000000000000000000000', '1000613149351'],
                ],
            },
            {
                source: 'Curve',
                inputOutputs: [
                    ['56455765167727658032301', '56492269823'],
                    ['115734318593841698966217', '115784594883'],
                    ['177976799691261441946828', '178015137705'],
                    ['243331404843552172076471', '243328362940'],
                    ['311953740253457438712595', '311875125558'],
                    ['384007192433857968680525', '383812659434'],
                    ['459663317223278525146852', '459304401655'],
                    ['539102248252170109436495', '538519542589'],
                    ['622513125832506272940621', '621632107843'],
                    ['710094547291859244619953', '708819215797'],
                    ['802055039824179864883251', '800257822584'],
                    ['898613556983116516159714', '896118544998'],
                    ['1000000000000000000000000', '996553461769'],
                ],
            },
            {
                source: 'Curve',
                inputOutputs: [
                    ['56455765167727658032301', '56485131020'],
                    ['115734318593841698966217', '115793128066'],
                    ['177976799691261441946828', '178064992945'],
                    ['243331404843552172076471', '243448763177'],
                    ['311953740253457438712595', '312099862332'],
                    ['384007192433857968680525', '384181467714'],
                    ['459663317223278525146852', '459864896286'],
                    ['539102248252170109436495', '539330009688'],
                    ['622513125832506272940621', '622765639328'],
                    ['710094547291859244619953', '710370032485'],
                    ['802055039824179864883251', '802351320488'],
                    ['898613556983116516159714', '898928010027'],
                    ['1000000000000000000000000', '1000329498728'],
                ],
            },
            {
                source: 'Curve',
                inputOutputs: [
                    ['56455765167727658032301', '56485129025'],
                    ['115734318593841698966217', '115794449287'],
                    ['177976799691261441946828', '178069163704'],
                    ['243331404843552172076471', '243457534656'],
                    ['311953740253457438712595', '312115236906'],
                    ['384007192433857968680525', '384205728133'],
                    ['459663317223278525146852', '459900637996'],
                    ['539102248252170109436495', '539380176646'],
                    ['622513125832506272940621', '622833563650'],
                    ['710094547291859244619953', '710459478345'],
                    ['802055039824179864883251', '802466532716'],
                    ['898613556983116516159714', '899073767884'],
                    ['1000000000000000000000000', '1000511175424'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['56455765167727658032301', '48066257410'],
                    ['115734318593841698966217', '84786646612'],
                    ['177976799691261441946828', '113523746579'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Swerve',
                inputOutputs: [
                    ['56455765167727658032301', '56480528329'],
                    ['115734318593841698966217', '115765591735'],
                    ['177976799691261441946828', '177993509598'],
                    ['243331404843552172076471', '243309256913'],
                    ['311953740253457438712595', '311864743459'],
                    ['384007192433857968680525', '383819092640'],
                    ['459663317223278525146852', '459338915460'],
                    ['539102248252170109436495', '538598573317'],
                    ['622513125832506272940621', '621780420588'],
                    ['710094547291859244619953', '709075014234'],
                    ['802055039824179864883251', '800681272055'],
                    ['898613556983116516159714', '896806553036'],
                    ['1000000000000000000000000', '997666620787'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['56455765167727658032301', '28569058185'],
                    ['115734318593841698966217', '38545878331'],
                    ['177976799691261441946828', '43619407817'],
                    ['243331404843552172076471', '46688390514'],
                    ['311953740253457438712595', '48742803118'],
                    ['384007192433857968680525', '50212886818'],
                    ['459663317223278525146852', '51315750656'],
                    ['539102248252170109436495', '52172805095'],
                    ['622513125832506272940621', '52857257064'],
                    ['710094547291859244619953', '53415873084'],
                    ['802055039824179864883251', '53879928035'],
                    ['898613556983116516159714', '54271129479'],
                    ['1000000000000000000000000', '54605016438'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['56455765167727658032301', '56014415783'],
                    ['115734318593841698966217', '114767754657'],
                    ['177976799691261441946828', '176390738537'],
                    ['243331404843552172076471', '241020004510'],
                    ['311953740253457438712595', '308798339580'],
                    ['384007192433857968680525', '379874921299'],
                    ['459663317223278525146852', '454405564029'],
                    ['539102248252170109436495', '532552970556'],
                    ['622513125832506272940621', '614486988660'],
                    ['710094547291859244619953', '700384872218'],
                    ['802055039824179864883251', '790431546323'],
                    ['898613556983116516159714', '884819875792'],
                    ['1000000000000000000000000', '983750936396'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['56455765167727658032301', '109573103'],
                    ['115734318593841698966217', '109683301'],
                    ['177976799691261441946828', '109720053'],
                    ['243331404843552172076471', '109738417'],
                    ['311953740253457438712595', '109749420'],
                    ['384007192433857968680525', '109756743'],
                    ['459663317223278525146852', '109761961'],
                    ['539102248252170109436495', '109765864'],
                    ['622513125832506272940621', '109768892'],
                    ['710094547291859244619953', '109771304'],
                    ['802055039824179864883251', '109773270'],
                    ['898613556983116516159714', '109774902'],
                    ['1000000000000000000000000', '109776276'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Shell',
                inputOutputs: [
                    ['56455765167727658032301', '56471884836'],
                    ['115734318593841698966217', '115729690769'],
                    ['177976799691261441946828', '177950386998'],
                    ['243331404843552172076471', '243282118038'],
                    ['311953740253457438712595', '311880435631'],
                    ['384007192433857968680525', '383908669103'],
                    ['459663317223278525146852', '459538314249'],
                    ['539102248252170109436495', '538949441652'],
                    ['622513125832506272940621', '622331125425'],
                    ['710094547291859244619953', '709881893387'],
                    ['802055039824179864883251', '801810199747'],
                    ['898613556983116516159714', '898334921425'],
                    ['1000000000000000000000000', '999685879186'],
                ],
            },
            {
                source: 'DODO',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['56455765167727658032301', '49818180769'],
                    ['115734318593841698966217', '91166365625'],
                    ['177976799691261441946828', '125997178358'],
                    ['243331404843552172076471', '155706184511'],
                    ['311953740253457438712595', '181317337653'],
                    ['384007192433857968680525', '203598966929'],
                    ['459663317223278525146852', '223138874156'],
                    ['539102248252170109436495', '240394425264'],
                    ['622513125832506272940621', '255726839384'],
                    ['710094547291859244619953', '269425201057'],
                    ['802055039824179864883251', '281723618063'],
                    ['898613556983116516159714', '292813703905'],
                    ['1000000000000000000000000', '302853806683'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['56455765167727658032301', '52006530811'],
                    ['115734318593841698966217', '98707962752'],
                    ['177976799691261441946828', '140828938360'],
                    ['243331404843552172076471', '178968547860'],
                    ['311953740253457438712595', '213626410405'],
                    ['384007192433857968680525', '245222511984'],
                    ['459663317223278525146852', '274112476687'],
                    ['539102248252170109436495', '300599452464'],
                    ['622513125832506272940621', '324943455780'],
                    ['710094547291859244619953', '347368787191'],
                    ['802055039824179864883251', '368069966985'],
                    ['898613556983116516159714', '387216524380'],
                    ['1000000000000000000000000', '404956890566'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['56455765167727658032301', '3597592530'],
                    ['115734318593841698966217', '3716706491'],
                    ['177976799691261441946828', '3758150240'],
                    ['243331404843552172076471', '3779195458'],
                    ['311953740253457438712595', '3791915849'],
                    ['384007192433857968680525', '3800426868'],
                    ['459663317223278525146852', '3806515085'],
                    ['539102248252170109436495', '3811081375'],
                    ['622513125832506272940621', '3814629255'],
                    ['710094547291859244619953', '3817462210'],
                    ['802055039824179864883251', '3819774054'],
                    ['898613556983116516159714', '3821694369'],
                    ['1000000000000000000000000', '3823313075'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Linkswap',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
            {
                source: 'Linkswap',
                inputOutputs: [
                    ['56455765167727658032301', '25974923'],
                    ['115734318593841698966217', '25983750'],
                    ['177976799691261441946828', '25986692'],
                    ['243331404843552172076471', '25988161'],
                    ['311953740253457438712595', '25989041'],
                    ['384007192433857968680525', '25989627'],
                    ['459663317223278525146852', '25990044'],
                    ['539102248252170109436495', '25990357'],
                    ['622513125832506272940621', '25990599'],
                    ['710094547291859244619953', '25990792'],
                    ['802055039824179864883251', '25990949'],
                    ['898613556983116516159714', '25991079'],
                    ['1000000000000000000000000', '25991189'],
                ],
            },
            {
                source: 'Linkswap',
                inputOutputs: [
                    ['56455765167727658032301', '0'],
                    ['115734318593841698966217', '0'],
                    ['177976799691261441946828', '0'],
                    ['243331404843552172076471', '0'],
                    ['311953740253457438712595', '0'],
                    ['384007192433857968680525', '0'],
                    ['459663317223278525146852', '0'],
                    ['539102248252170109436495', '0'],
                    ['622513125832506272940621', '0'],
                    ['710094547291859244619953', '0'],
                    ['802055039824179864883251', '0'],
                    ['898613556983116516159714', '0'],
                    ['1000000000000000000000000', '0'],
                ],
            },
        ];
        const DEX_QUOTES_4 = [
            {
                source: 'Uniswap',
                inputOutputs: [
                    ['28227882583863829017', '41815800929649197687753'],
                    ['57867159296920849484', '76342898802772781858085'],
                    ['88988399845630720974', '105302496796947494014239'],
                    ['121665702421776086039', '129913649848330935937933'],
                    ['155976870126728719357', '151063955042313615931218'],
                    ['192003596216928984341', '169415048290898955417990'],
                    ['229831658611639262574', '185470218901778954457744'],
                    ['269551124126085054719', '199619115853775440190761'],
                    ['311256562916253136471', '212168116845681056249979'],
                    ['355047273645929622310', '223361452180307385803297'],
                    ['401027519912089932442', '233396208476691418167238'],
                    ['449306778491558258080', '242433185622470701038729'],
                    ['500000000000000000000', '250604885185738103579540'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['28227882583863829017', '47009967428235591415411'],
                    ['57867159296920849484', '96281132901793703980484'],
                    ['88988399845630720974', '147917676682503899778663'],
                    ['121665702421776086039', '202028119812586377610207'],
                    ['155976870126728719357', '258725458517058731671924'],
                    ['192003596216928984341', '318127297805661353832585'],
                    ['229831658611639262574', '380355983602319609784279'],
                    ['269551124126085054719', '445538732651491544853612'],
                    ['311256562916253136471', '513807759366196919881973'],
                    ['355047273645929622310', '585300398691928650618904'],
                    ['401027519912089932442', '660159223963896032006702'],
                    ['449306778491558258080', '738532158632078607691376'],
                    ['500000000000000000000', '820572580619383338910835'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['28227882583863829017', '46517380110889316508326'],
                    ['57867159296920849484', '94581086201846493133709'],
                    ['88988399845630720974', '144209445726142397164094'],
                    ['121665702421776086039', '195418154395506471631310'],
                    ['155976870126728719357', '248220043292060106606373'],
                    ['192003596216928984341', '302624845560448981751730'],
                    ['229831658611639262574', '358638964677641831580669'],
                    ['269551124126085054719', '416265246416595178836790'],
                    ['311256562916253136471', '475502756843207496321414'],
                    ['355047273645929622310', '536346568810538665535028'],
                    ['401027519912089932442', '598787559523803691210203'],
                    ['449306778491558258080', '662812221906857656678034'],
                    ['500000000000000000000', '728402492502868290956036'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['28227882583863829017', '46570165383094642016833'],
                    ['57867159296920849484', '95063828285803558672366'],
                    ['88988399845630720974', '145541312188702084741262'],
                    ['121665702421776086039', '198063061368701671286167'],
                    ['155976870126728719357', '252689451668499514432436'],
                    ['192003596216928984341', '309480583912112810922059'],
                    ['229831658611639262574', '368496059558093338311332'],
                    ['269551124126085054719', '429794738257517416465027'],
                    ['311256562916253136471', '493434477164497981363549'],
                    ['355047273645929622310', '559471851982067517409889'],
                    ['401027519912089932442', '627961859893640927729984'],
                    ['449306778491558258080', '698957604763009738402953'],
                    ['500000000000000000000', '772509965191659771312966'],
                ],
            },
            {
                source: 'Uniswap_V2',
                inputOutputs: [
                    ['28227882583863829017', '31122572781725776681111'],
                    ['57867159296920849484', '46975602386894237986517'],
                    ['88988399845630720974', '56573710745803112937279'],
                    ['121665702421776086039', '63002420453969473423900'],
                    ['155976870126728719357', '67604421865093916884292'],
                    ['192003596216928984341', '71057843786627231607957'],
                    ['229831658611639262574', '73742136701238222542313'],
                    ['269551124126085054719', '75886203036317689904750'],
                    ['311256562916253136471', '77636324129711687874306'],
                    ['355047273645929622310', '79090353081782252548703'],
                    ['401027519912089932442', '80316224775426412600743'],
                    ['449306778491558258080', '81362578965650498977029'],
                    ['500000000000000000000', '82265157151578812729250'],
                ],
            },
            {
                source: 'Eth2Dai',
                inputOutputs: [
                    ['28227882583863829017', '38248780901135488318035'],
                    ['57867159296920849484', '78160865398976343349516'],
                    ['88988399845630720974', '78950927038101363501265'],
                    ['121665702421776086039', '78987198843960884856487'],
                    ['155976870126728719357', '79025284240113382279470'],
                    ['192003596216928984341', '79065273906073504573602'],
                    ['229831658611639262574', '79107263055331632982441'],
                    ['269551124126085054719', '79150132917274164991001'],
                    ['311256562916253136471', '79191838356064333072753'],
                    ['355047273645929622310', '79235629066794009558592'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['28227882583863829017', '46940982048046483652807'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['28227882583863829017', '46933213662589336762262'],
                    ['57867159296920849484', '96174591224069545527382'],
                    ['88988399845630720974', '147868155257425930324526'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Kyber',
                inputOutputs: [
                    ['28227882583863829017', '46894790655171123958934'],
                    ['57867159296920849484', '96038042104149276018905'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '42283372020137337199386'],
                    ['57867159296920849484', '78095604766362589563315'],
                    ['88988399845630720974', '108741058344764546170441'],
                    ['121665702421776086039', '135200354605554703174454'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '47073304466717065866881'],
                    ['57867159296920849484', '96305995396678651353029'],
                    ['88988399845630720974', '147787163377397333602195'],
                    ['121665702421776086039', '201608574654101594602909'],
                    ['155976870126728719357', '257864645765197712584481'],
                    ['192003596216928984341', '316652403957859283630717'],
                    ['229831658611639262574', '378071431815644988128894'],
                    ['269551124126085054719', '442223794426197917114280'],
                    ['311256562916253136471', '509213947313005707911198'],
                    ['355047273645929622310', '579148623252178848514904'],
                    ['401027519912089932442', '652136695994740074533001'],
                    ['449306778491558258080', '728289018818812971568533'],
                    ['500000000000000000000', '807718235746423270773500'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '47158187128734788933871'],
                    ['57867159296920849484', '96382818100753590472993'],
                    ['88988399845630720974', '147750239473296885023067'],
                    ['121665702421776086039', '201338265901788721056267'],
                    ['155976870126728719357', '257226070178331007907980'],
                    ['192003596216928984341', '315494056480750768207525'],
                    ['229831658611639262574', '376223715733192888404243'],
                    ['269551124126085054719', '439497461989480248613277'],
                    ['311256562916253136471', '505398448774316422444536'],
                    ['355047273645929622310', '574010364356780195482884'],
                    ['401027519912089932442', '645417204987421347247794'],
                    ['449306778491558258080', '719703025206624058029363'],
                    ['500000000000000000000', '796951664429777281399405'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '36488080632581549619723'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Balancer',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Bancor',
                inputOutputs: [
                    ['28227882583863829017', '47098235286408350783994'],
                    ['57867159296920849484', '96392202131928917287715'],
                    ['88988399845630720974', '147976238330696761657229'],
                    ['121665702421776086039', '201947944986834208915829'],
                    ['155976870126728719357', '258408219778846122055988'],
                    ['192003596216928984341', '317461281301112941971152'],
                    ['229831658611639262574', '379214683325782307451825'],
                    ['269551124126085054719', '443779317745985692208219'],
                    ['311256562916253136471', '511269404877906225630512'],
                    ['355047273645929622310', '581802469715591699333460'],
                    ['401027519912089932442', '655499302649487723292909'],
                    ['449306778491558258080', '732483903078570458936323'],
                    ['500000000000000000000', '812883404267976105532629'],
                ],
            },
            {
                source: 'mStable',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['28227882583863829017', '23930150486532786957886'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Mooniswap',
                inputOutputs: [
                    ['28227882583863829017', '41812012829496487639501'],
                    ['57867159296920849484', '76190762494530303098992'],
                    ['88988399845630720974', '104420482933964494104731'],
                    ['121665702421776086039', '127546995872473166652537'],
                    ['155976870126728719357', '146426431618128379024096'],
                    ['192003596216928984341', '161762992805669109150011'],
                    ['229831658611639262574', '174138452029212082031609'],
                    ['269551124126085054719', '184035359116329624325029'],
                    ['311256562916253136471', '191855422589129856421966'],
                    ['355047273645929622310', '197934160658600230457372'],
                    ['401027519912089932442', '202552647861581845858267'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829017', '47083295875845959126244'],
                    ['57867159296920849484', '96497874329209018164371'],
                    ['88988399845630720974', '148357972013752047787478'],
                    ['121665702421776086039', '202783301659075428996905'],
                    ['155976870126728719357', '259899302147963764349712'],
                    ['192003596216928984341', '319837398733720898959249'],
                    ['229831658611639262574', '382735273672863663968767'],
                    ['269551124126085054719', '448737147540077153862430'],
                    ['311256562916253136471', '517994071481526702503315'],
                    ['355047273645929622310', '590664230649081849547799'],
                    ['401027519912089932442', '666913259041416705694814'],
                    ['449306778491558258080', '746914565957962067490250'],
                    ['500000000000000000000', '830849674247920045126275'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829017', '117587604331116107368'],
                    ['57867159296920849484', '117738550028457920174'],
                    ['88988399845630720974', '117788911429983727277'],
                    ['121665702421776086039', '117814078323368026562'],
                    ['155976870126728719357', '117829159682320344970'],
                    ['192003596216928984341', '117839196156271775193'],
                    ['229831658611639262574', '117846349089370340642'],
                    ['269551124126085054719', '117851699507911212686'],
                    ['311256562916253136471', '117855848125404520604'],
                    ['355047273645929622310', '117859155437152199391'],
                    ['401027519912089932442', '117861850884748639968'],
                    ['449306778491558258080', '117864087450018973342'],
                    ['500000000000000000000', '117865971056732441303'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829017', '25860302660415524902341'],
                    ['57867159296920849484', '36026455547358376855743'],
                    ['88988399845630720974', '41454291797862562281600'],
                    ['121665702421776086039', '44827162936770650323174'],
                    ['155976870126728719357', '47124026152773455117753'],
                    ['192003596216928984341', '48787240556871030154282'],
                    ['229831658611639262574', '50045917135446333681673'],
                    ['269551124126085054719', '51030599318487194357420'],
                    ['311256562916253136471', '51821122992464642469362'],
                    ['355047273645929622310', '52469058449782357640150'],
                    ['401027519912089932442', '53009202802160199965241'],
                    ['449306778491558258080', '53465886863112338438924'],
                    ['500000000000000000000', '53856635318484194949937'],
                ],
            },
            {
                source: 'SushiSwap',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'DODO_V2',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['28227882583863829017', '44976318207018873069500'],
                    ['57867159296920849484', '87952714535133238009126'],
                    ['88988399845630720974', '129011864042497581851250'],
                    ['121665702421776086039', '168233590894868682683947'],
                    ['155976870126728719357', '205694913686074341625495'],
                    ['192003596216928984341', '241470095673325329322291'],
                    ['229831658611639262574', '275630699200921609151763'],
                    ['269551124126085054719', '308245643646534102154132'],
                    ['311256562916253136471', '339381266281806727030720'],
                    ['355047273645929622310', '369101385493448871773901'],
                    ['401027519912089932442', '397467365862249011203461'],
                    ['449306778491558258080', '424538184645546389213522'],
                    ['500000000000000000000', '450370499253690972316458'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['28227882583863829017', '4852954321908198504741'],
                    ['57867159296920849484', '5128339482696949102783'],
                    ['88988399845630720974', '5227133843405433760600'],
                    ['121665702421776086039', '5277911279565505566528'],
                    ['155976870126728719357', '5308804728435153240344'],
                    ['192003596216928984341', '5329560736399243100299'],
                    ['229831658611639262574', '5344450568181167299872'],
                    ['269551124126085054719', '5355641529403531879559'],
                    ['311256562916253136471', '5364350405221858863490'],
                    ['355047273645929622310', '5371313067456255911071'],
                    ['401027519912089932442', '5377000705132019532216'],
                    ['449306778491558258080', '5381729013505321871343'],
                    ['500000000000000000000', '5385717450500882017268'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['28227882583863829017', '41774234110632657655066'],
                    ['57867159296920849484', '76441665583180550910424'],
                    ['88988399845630720974', '105641643438495291549884'],
                    ['121665702421776086039', '130545569094761526731517'],
                    ['155976870126728719357', '152012759047296877641168'],
                    ['192003596216928984341', '170687900674579375387496'],
                    ['229831658611639262574', '187064134912960804253509'],
                    ['269551124126085054719', '201525124652849711918753'],
                    ['311256562916253136471', '214373846313026628455345'],
                    ['355047273645929622310', '225852748829033190895622'],
                    ['401027519912089932442', '236158156023999461393959'],
                    ['449306778491558258080', '245450743064286793952758'],
                    ['500000000000000000000', '253863281256696543368559'],
                ],
            },
            {
                source: 'CryptoCom',
                inputOutputs: [
                    ['28227882583863829017', '1358245972994'],
                    ['57867159296920849484', '1358245981041'],
                    ['88988399845630720974', '1358245983722'],
                    ['121665702421776086039', '1358245985061'],
                    ['155976870126728719357', '1358245985862'],
                    ['192003596216928984341', '1358245986396'],
                    ['229831658611639262574', '1358245986776'],
                    ['269551124126085054719', '1358245987061'],
                    ['311256562916253136471', '1358245987281'],
                    ['355047273645929622310', '1358245987457'],
                    ['401027519912089932442', '1358245987600'],
                    ['449306778491558258080', '1358245987719'],
                    ['500000000000000000000', '1358245987819'],
                ],
            },
            {
                source: 'Linkswap',
                inputOutputs: [
                    ['28227882583863829017', '0'],
                    ['57867159296920849484', '0'],
                    ['88988399845630720974', '0'],
                    ['121665702421776086039', '0'],
                    ['155976870126728719357', '0'],
                    ['192003596216928984341', '0'],
                    ['229831658611639262574', '0'],
                    ['269551124126085054719', '0'],
                    ['311256562916253136471', '0'],
                    ['355047273645929622310', '0'],
                    ['401027519912089932442', '0'],
                    ['449306778491558258080', '0'],
                    ['500000000000000000000', '0'],
                ],
            },
            {
                source: 'Linkswap',
                inputOutputs: [
                    ['28227882583863829017', '37655060387276733267'],
                    ['57867159296920849484', '37664922917746589877'],
                    ['88988399845630720974', '37668208967876004492'],
                    ['121665702421776086039', '37669850253969714594'],
                    ['155976870126728719357', '37670833533603224205'],
                    ['192003596216928984341', '37671487784047465376'],
                    ['229831658611639262574', '37671954010158845060'],
                    ['269551124126085054719', '37672302719436765141'],
                    ['311256562916253136471', '37672573084936547709'],
                    ['355047273645929622310', '37672788611665664553'],
                    ['401027519912089932442', '37672964258079604443'],
                    ['449306778491558258080', '37673109996984880256'],
                    ['500000000000000000000', '37673232733014196298'],
                ],
            },
        ];

        const ITERS = 1;
        const TIMEOUT = 300000;

        const performTestAsync = async (
            quotes: any,
            targetInput: BigNumber,
            expectedOutput: BigNumber,
            iters: number = ITERS,
        ) => {
            const dexQuotes = quotes.map((qs: any) => {
                const exploded = [];
                for (const io of qs.inputOutputs) {
                    const [input, output] = io;
                    exploded.push({
                        source: 'Test' as ERC20BridgeSource,
                        input: new BigNumber(input),
                        output: new BigNumber(output),
                        fillData: {} as any,
                    });
                }
                return exploded;
            });
            const args = {
                side: MarketOperation.Sell,
                orders: [],
                dexQuotes,
                targetInput,
                outputAmountPerEth: new BigNumber('244.561443680926014385'),
                inputAmountPerEth: new BigNumber('1'),
                excludedSources: [],
                feeSchedule: { Test: () => 500e3 } as any,
            };
            const fills = createFills(args);

            let timeBefore = Date.now();
            for (let i = 0; i < iters; i++) {
                const path = await findOptimalPathAsync(args.side, fills, args.targetInput, 2 ** 15, {
                    outputAmountPerEth: args.outputAmountPerEth,
                    inputAmountPerEth: args.inputAmountPerEth,
                    exchangeProxyOverhead: () => ZERO_AMOUNT,
                });
                const output = path!.adjustedSize().output;
                expect(output).to.be.bignumber.greaterThan(expectedOutput);
            }
            console.log(Date.now() - timeBefore);

            timeBefore = Date.now();
            for (let i = 0; i < iters; i++) {
                const path = await findOptimalPath2Async(args.side, fills, args.targetInput, 2 ** 15, {
                    outputAmountPerEth: args.outputAmountPerEth,
                    inputAmountPerEth: args.inputAmountPerEth,
                    exchangeProxyOverhead: () => ZERO_AMOUNT,
                });
                const output = path!.adjustedSize().output;
                expect(output).to.be.bignumber.greaterThan(expectedOutput);
            }
            console.log(Date.now() - timeBefore);
        };

        it('DEX QUOTES BNB/BUSD SMALL', async () => {
            await performTestAsync(
                DEX_QUOTES_1,
                new BigNumber('300000000000000'),
                new BigNumber('76873601117992638'),
                ITERS,
            );
        }).timeout(TIMEOUT);

        it('DEX QUOTES BNB/BUSD LARGE', async () => {
            await performTestAsync(
                DEX_QUOTES_2,
                new BigNumber('500000000000000000000000000'),
                new BigNumber('531217466965478791705650'),
                ITERS,
            );
        }).timeout(TIMEOUT);

        it('DEX QUOTES DAI/USDC LARGE', async () => {
            await performTestAsync(
                DEX_QUOTES_3,
                new BigNumber('1000000000000000000000000'),
                new BigNumber('1000490868629'),
                ITERS,
            );
        }).timeout(TIMEOUT);

        it('DEX QUOTES ETH/DAI LARGE', async () => {
            await performTestAsync(
                DEX_QUOTES_3,
                new BigNumber('500000000000000000000'),
                new BigNumber('832264828507455811613443'),
                ITERS,
            );
        }).timeout(TIMEOUT);
    });
});
// tslint:disable-next-line: max-file-line-count
