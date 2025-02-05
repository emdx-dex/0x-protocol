import { generatePseudoRandomSalt } from '@emdx-dex/order-utils';
import { Order, SignatureType, SignedOrder } from '@0x/types';
import { BigNumber } from '@0x/utils';

import { getLatestBlockTimestampAsync } from './block_timestamp';
import { constants } from './constants';
import { orderHashUtils } from './order_hash';
import { signingUtils } from './signing_utils';

export class OrderFactory {
    private readonly _defaultOrderParams: Partial<Order>;
    private readonly _privateKey: Buffer;

    constructor(privateKey: Buffer, defaultOrderParams: Partial<Order>) {
        this._defaultOrderParams = defaultOrderParams;
        this._privateKey = privateKey;
    }

    public async newSignedOrderAsync(
        customOrderParams: Partial<Order> = {},
        signatureType: SignatureType = SignatureType.EthSign,
    ): Promise<SignedOrder> {
        const fifteenMinutesInSeconds = 15 * 60;
        const currentBlockTimestamp = await getLatestBlockTimestampAsync();
        const order = {
            takerAddress: constants.NULL_ADDRESS,
            senderAddress: constants.NULL_ADDRESS,
            expirationTimeSeconds: new BigNumber(currentBlockTimestamp).plus(fifteenMinutesInSeconds),
            salt: generatePseudoRandomSalt(),
            ...this._defaultOrderParams,
            ...customOrderParams,
        } as Order; // tslint:disable-line:no-object-literal-type-assertion
        const orderHashBuff = orderHashUtils.getOrderHashBuffer(order);
        const signature = signingUtils.signMessage(orderHashBuff, this._privateKey, signatureType);
        const signedOrder = {
            ...order,
            signature: `0x${signature.toString('hex')}`,
        };
        return signedOrder;
    }
}
