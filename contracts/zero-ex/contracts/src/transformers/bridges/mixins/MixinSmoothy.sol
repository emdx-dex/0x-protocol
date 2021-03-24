// SPDX-License-Identifier: Apache-2.0
/*

  Copyright 2021 ZeroEx Intl.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

*/

pragma solidity ^0.6.5;
pragma experimental ABIEncoderV2;

import "@0x/contracts-erc20/contracts/src/v06/LibERC20TokenV06.sol";
import "@0x/contracts-erc20/contracts/src/v06/IERC20TokenV06.sol";
import "@0x/contracts-utils/contracts/src/v06/LibSafeMathV06.sol";

interface ISmoothy {

    function swap(
        uint256 bTokenIdxIn,
        uint256 bTokenIdxOut,
        uint256 bTokenInAmount,
        uint256 bTokenOutMin
    )
        external;
}

contract MixinSmoothy {

    using LibERC20TokenV06 for IERC20TokenV06;
    using LibSafeMathV06 for uint256;

    struct SmoothyBridgeData {
        address poolAddress;
        uint256 fromCoinIdx;
        uint256 toCoinIdx;
    }

    function _tradeSmoothy(
        IERC20TokenV06 sellToken,
        IERC20TokenV06 buyToken,
        uint256 sellAmount,
        bytes memory bridgeData
    )
        internal
        returns (uint256 boughtAmount)
    {
        SmoothyBridgeData memory data = abi.decode(bridgeData, (SmoothyBridgeData));

        // Grant the Smoothy contract an allowance to sell the first token.
        IERC20TokenV06(sellToken).approveIfBelow(
            address(data.poolAddress),
            sellAmount
        );

        uint256 beforeBalance = buyToken.balanceOf(address(this));

        ISmoothy(data.poolAddress).swap(
            data.fromCoinIdx,
            data.toCoinIdx,
            sellAmount,
            // minBuyAmount
            1
        );

        return buyToken.balanceOf(address(this)).safeSub(beforeBalance);
    }
}
