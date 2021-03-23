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

pragma solidity ^0.6;
pragma experimental ABIEncoderV2;

import "./DeploymentConstants.sol";
import "./interfaces/ISmoothy.sol";

contract SmoothySampler is
    DeploymentConstants
{
    /// @dev Information for sampling from Smoothy sources.
    struct SmoothyInfo {
        address poolAddress;
    }

    /// @dev Default gas limit for Smoothy calls.
    uint256 constant private DEFAULT_CALL_GAS = 1000e3;

    /// @dev Sample sell quotes from Smoothy.
    /// @param pool Address of the Smoothy pool contract
    /// @param fromTokenIdx Index of the taker token (what to sell).
    /// @param toTokenIdx Index of the maker token (what to buy).
    /// @param takerTokenAmounts Taker token sell amount for each sample.
    /// @return makerTokenAmounts Maker amounts bought at each taker token
    ///         amount.
    function sampleSellsFromSmoothy(
        address pool,
        uint256 fromTokenIdx,
        uint256 toTokenIdx,
        uint256[] memory takerTokenAmounts
    )
        public
        view
        returns (uint256[] memory makerTokenAmounts)
    {
        // Initialize array of maker token amounts.
        uint256 numSamples = takerTokenAmounts.length;
        makerTokenAmounts = new uint256[](numSamples);

        for (uint256 i = 0; i < numSamples; i++) {
            try
                ISmoothy(pool).getSwapAmount
                    {gas: DEFAULT_CALL_GAS}
                    (fromTokenIdx, toTokenIdx, takerTokenAmounts[i])
                returns (uint256 amount)
            {
                makerTokenAmounts[i] = amount;
            } catch (bytes memory) {
                // Swallow failures, leaving all results as zero.
                break;
            }
        }
    }
    /// @dev Sample buy quotes from Smoothy pool contract
    /// @param pool Address of the Smoothy pool contract
    /// @param fromTokenIdx Index of the taker token (what to sell).
    /// @param toTokenIdx Index of the maker token (what to buy).
    /// @param makerTokenAmounts Maker token buy amount for each sample.
    /// @return takerTokenAmounts Taker amounts sold at each maker token
    ///         amount.
    function sampleBuysFromSmoothy(
        address pool,
        uint256 fromTokenIdx,
        uint256 toTokenIdx,
        uint256[] memory makerTokenAmounts
    )
        public
        view
        returns (uint256[] memory takerTokenAmounts)
    {
        // Initialize array of maker token amounts.
        uint256 numSamples = makerTokenAmounts.length;
        takerTokenAmounts = new uint256[](numSamples);

        for (uint256 i = 0; i < numSamples; i++) {
            try
                ISmoothy(pool).getSwapAmount
                    {gas: DEFAULT_CALL_GAS}
                    (fromTokenIdx, toTokenIdx, makerTokenAmounts[i])
                returns (uint256 amount)
            {
                takerTokenAmounts[i] = amount;
            } catch (bytes memory) {
                // Swallow failures, leaving all results as zero.
                break;
            }
        }
    }
}