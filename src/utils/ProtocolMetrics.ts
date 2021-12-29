import { Address, BigDecimal, BigInt, log } from '@graphprotocol/graph-ts'
import { KlimaERC20V1 } from '../../generated/KlimaStakingV1/KlimaERC20V1';
import { sKlimaERC20V1 } from '../../generated/KlimaStakingV1/sKlimaERC20V1';
import { ERC20 } from '../../generated/KlimaStakingV1/ERC20';
import { UniswapV2Pair } from '../../generated/KlimaStakingV1/UniswapV2Pair';
import { KlimaStakingV1 } from '../../generated/KlimaStakingV1/KlimaStakingV1';

import { ProtocolMetric, Transaction, TreasuryAsset } from '../../generated/schema'
import * as constants from './Constants';
import { dayFromTimestamp } from './Dates';
import { toDecimal } from './Decimals';
import { getKLIMAUSDRate, getDiscountedPairCO2, getKlimaPairUSD, getBCTUSDRate } from './Price';
import { getHolderAux } from './Aux';
//import { updateBondDiscounts } from './BondDiscounts';

export function loadOrCreateProtocolMetric(timestamp: BigInt): ProtocolMetric {
    let dayTimestamp = dayFromTimestamp(timestamp);

    let protocolMetric = ProtocolMetric.load(dayTimestamp)
    if (protocolMetric == null) {
        protocolMetric = new ProtocolMetric(dayTimestamp)
        protocolMetric.timestamp = timestamp
        protocolMetric.klimaCirculatingSupply = BigDecimal.fromString("0")
        protocolMetric.sKlimaCirculatingSupply = BigDecimal.fromString("0")
        protocolMetric.totalSupply = BigDecimal.fromString("0")
        protocolMetric.klimaPrice = BigDecimal.fromString("0")
        protocolMetric.marketCap = BigDecimal.fromString("0")
        protocolMetric.totalValueLocked = BigDecimal.fromString("0")
        protocolMetric.assets = []
        protocolMetric.treasuryRiskFreeValue = BigDecimal.fromString("0")
        protocolMetric.treasuryMarketValue = BigDecimal.fromString("0")
        protocolMetric.nextEpochRebase = BigDecimal.fromString("0")
        protocolMetric.nextDistributedKlima = BigDecimal.fromString("0")
        protocolMetric.currentAPY = BigDecimal.fromString("0")
        protocolMetric.treasuryCarbon = BigDecimal.fromString("0")
        protocolMetric.holders = BigInt.fromI32(0)

        protocolMetric.save()
    }
    return protocolMetric as ProtocolMetric
}

export function loadOrCreateTreasuryAsset(timestamp: BigInt, token: String): TreasuryAsset {
    let dayTimestamp = dayFromTimestamp(timestamp);

    let treasuryAsset = TreasuryAsset.load(dayTimestamp + token)
    if (treasuryAsset == null) {
        treasuryAsset = new TreasuryAsset(dayTimestamp + token)
        treasuryAsset.timestamp = timestamp
        treasuryAsset.token = token.toString()
        treasuryAsset.tokenBalance = BigDecimal.fromString("0")
        treasuryAsset.carbonBalance = BigDecimal.fromString("0")
        treasuryAsset.riskFreeValue = BigDecimal.fromString("0")
        treasuryAsset.marketValue = BigDecimal.fromString("0")
        treasuryAsset.POL = BigDecimal.fromString("0")

        treasuryAsset.save()
    }

    return treasuryAsset as TreasuryAsset
}


function getTotalSupply(): BigDecimal {
    let klima_contract = KlimaERC20V1.bind(Address.fromString(constants.KLIMA_ERC20_V1_CONTRACT))
    let total_supply = toDecimal(klima_contract.totalSupply(), 9)
    log.debug("Total Supply {}", [total_supply.toString()])
    return total_supply
}

function getCriculatingSupply(transaction: Transaction, total_supply: BigDecimal): BigDecimal {

    let klima_contract = KlimaERC20V1.bind(Address.fromString(constants.KLIMA_ERC20_V1_CONTRACT))

    // Start with total supply
    let circ_supply = total_supply

    // Subtract DAO Balance
    circ_supply = circ_supply.minus(toDecimal(klima_contract.balanceOf(Address.fromString(constants.DAO_MULTISIG)), 9))

    // Subtract Bond Rewards
    circ_supply = circ_supply.minus(toDecimal(klima_contract.balanceOf(Address.fromString(constants.BCTBOND_V1)), 9))
    circ_supply = circ_supply.minus(toDecimal(klima_contract.balanceOf(Address.fromString(constants.BCT_USDC_BOND_V1)), 9))
    circ_supply = circ_supply.minus(toDecimal(klima_contract.balanceOf(Address.fromString(constants.KLIMA_BCT_BOND_V1)), 9))

    log.debug("Circulating Supply {}", [total_supply.toString()])
    return circ_supply
}

function getSklimaSupply(transaction: Transaction): BigDecimal {
    let sklima_supply = BigDecimal.fromString("0")

    let sklima_contract_v1 = sKlimaERC20V1.bind(Address.fromString(constants.SKLIMA_ERC20_V1_CONTRACT))
    sklima_supply = toDecimal(sklima_contract_v1.circulatingSupply(), 9)

    log.debug("sKLIMA Supply {}", [sklima_supply.toString()])
    return sklima_supply
}

function updateTreasuryAssets(transaction: Transaction): string[] {

    let treasuryAddress = Address.fromString(constants.TREASURY_ADDRESS)

    // BCT
    let bctERC20 = ERC20.bind(Address.fromString(constants.BCT_ERC20_CONTRACT))
    let treasuryBCT = loadOrCreateTreasuryAsset(transaction.timestamp, constants.BCT_ERC20_CONTRACT)

    // Treasury token balance
    treasuryBCT.tokenBalance = toDecimal(bctERC20.balanceOf(treasuryAddress), 18)
    // Reserve asset so carbon and RFV = token balance
    treasuryBCT.carbonBalance = treasuryBCT.tokenBalance
    treasuryBCT.riskFreeValue = treasuryBCT.tokenBalance

    // Get market value if pools are deployed
    if (transaction.blockNumber.gt(BigInt.fromString(constants.BCT_USDC_PAIR_BLOCK))) {
        treasuryBCT.marketValue = treasuryBCT.tokenBalance.times(getBCTUSDRate())
    }

    treasuryBCT.save()


    // KLIMA-BCT

    let klimabctERC20 = ERC20.bind(Address.fromString(constants.KLIMA_BCT_PAIR))
    let klimabctUNIV2 = UniswapV2Pair.bind(Address.fromString(constants.KLIMA_BCT_PAIR))

    let treasuryKLIMABCT = loadOrCreateTreasuryAsset(transaction.timestamp, constants.KLIMA_BCT_PAIR)
    if (transaction.blockNumber.gt(BigInt.fromString(constants.KLIMA_BCT_PAIR_BLOCK))) {

        // Treasury LP token balance
        treasuryKLIMABCT.tokenBalance = toDecimal(klimabctERC20.balanceOf(treasuryAddress), 18)

        // Get total LP supply and calc treasury percent
        let total_lp = toDecimal(klimabctUNIV2.totalSupply(), 18)
        let ownedLP = treasuryKLIMABCT.tokenBalance.div(total_lp)
        treasuryKLIMABCT.POL = ownedLP

        // Percent of Carbon in LP owned by the treasury
        treasuryKLIMABCT.carbonBalance = toDecimal(klimabctUNIV2.getReserves().value0, 18).times(ownedLP)
        treasuryKLIMABCT.marketValue = treasuryKLIMABCT.carbonBalance.times(getBCTUSDRate())

    }

    treasuryKLIMABCT.save()

    // BCT-USDC

    let bctusdcERC20 = ERC20.bind(Address.fromString(constants.BCT_USDC_PAIR))
    let bctusdcUNIV2 = UniswapV2Pair.bind(Address.fromString(constants.BCT_USDC_PAIR))

    let treasuryBCTUSDC = loadOrCreateTreasuryAsset(transaction.timestamp, constants.BCT_USDC_PAIR)
    if (transaction.blockNumber.gt(BigInt.fromString(constants.BCT_USDC_PAIR_BLOCK))) {

        // Treasury LP token balance
        treasuryBCTUSDC.tokenBalance = toDecimal(bctusdcERC20.balanceOf(treasuryAddress), 18)

        // Get total LP supply and calc treasury percent
        let total_lp = toDecimal(bctusdcUNIV2.totalSupply(), 18)
        let ownedLP = treasuryBCTUSDC.tokenBalance.div(total_lp)
        treasuryBCTUSDC.POL = ownedLP

        // Percent of Carbon in LP owned by the treasury
        treasuryBCTUSDC.carbonBalance = toDecimal(bctusdcUNIV2.getReserves().value1, 18).times(ownedLP)
        treasuryBCTUSDC.marketValue = treasuryBCTUSDC.carbonBalance.times(getBCTUSDRate())

    }

    treasuryBCTUSDC.save()

    return [
        treasuryBCT.id,
        treasuryKLIMABCT.id,
        treasuryBCTUSDC.id
    ]
}

function getMV_RFV(transaction: Transaction, assets: string[]): BigDecimal[] {

    let totalCarbon = BigDecimal.fromString("0")
    let totalRFV = BigDecimal.fromString("0")
    let totalMarketValue = BigDecimal.fromString("0")

    for (let i = 0; i < assets.length; i++) {
        let assetDetail = loadOrCreateTreasuryAsset(transaction.timestamp, assets[i].substring(10))
        totalCarbon = totalCarbon.plus(assetDetail.carbonBalance)
        totalRFV = totalRFV.plus(assetDetail.riskFreeValue)
        totalMarketValue = totalMarketValue.plus(assetDetail.marketValue)
    }

    log.debug("Treasury Carbon {}", [totalCarbon.toString()])
    log.debug("Treasury RFV {}", [totalRFV.toString()])
    log.debug("Treasury Market Value {}", [totalMarketValue.toString()])

    return [
        totalCarbon,
        totalRFV,
        totalMarketValue
    ]
}

function getNextKLIMARebase(transaction: Transaction): BigDecimal {
    let next_distribution = BigDecimal.fromString("0")

    let staking_contract_v1 = KlimaStakingV1.bind(Address.fromString(constants.STAKING_CONTRACT_V1))
    let distribution_v1 = toDecimal(staking_contract_v1.epoch().value3, 9)
    log.debug("next_distribution v1 {}", [distribution_v1.toString()])
    next_distribution = next_distribution.plus(distribution_v1)


    log.debug("next_distribution total {}", [next_distribution.toString()])

    return next_distribution
}

function getAPY_Rebase(sKLIMA: BigDecimal, distributedKLIMA: BigDecimal): BigDecimal[] {
    // Check for 0 sKLIMA supply
    if (sKLIMA == BigDecimal.fromString("0")) { return [BigDecimal.fromString("0"), BigDecimal.fromString("0")] }

    let nextEpochRebase = distributedKLIMA.div(sKLIMA).times(BigDecimal.fromString("100"));

    let nextEpochRebase_number = Number.parseFloat(nextEpochRebase.toString())
    let currentAPY = Math.pow(((nextEpochRebase_number / 100) + 1), (365 * 3.28) - 1) * 100

    let currentAPYdecimal = BigDecimal.fromString(currentAPY.toString())

    log.debug("next_rebase {}", [nextEpochRebase.toString()])
    log.debug("current_apy total {}", [currentAPYdecimal.toString()])

    return [currentAPYdecimal, nextEpochRebase]
}

function getRunway(sKLIMA: BigDecimal, rfv: BigDecimal, rebase: BigDecimal): BigDecimal {
    //let runway100 = BigDecimal.fromString("0")
    //let runway250 = BigDecimal.fromString("0")
    //let runway500 = BigDecimal.fromString("0")
    //let runway1k = BigDecimal.fromString("0")
    //let runway2dot5k = BigDecimal.fromString("0")
    //let runway5k = BigDecimal.fromString("0")
    let runwayCurrent = BigDecimal.fromString("0")

    // Keeping placeholder math entered, just commented in case we want in the future.
    if (sKLIMA.gt(BigDecimal.fromString("0")) && rfv.gt(BigDecimal.fromString("0")) && rebase.gt(BigDecimal.fromString("0"))) {
        let treasury_runway = Number.parseFloat(rfv.div(sKLIMA).toString())

        //let runway100_num = (Math.log(treasury_runway) / Math.log(1)) / 3.28;
        //let runway250_num = (Math.log(treasury_runway) / Math.log(1 + 0.000763867)) / 3.28;
        //let runway500_num = (Math.log(treasury_runway) / Math.log(1 + 0.001342098)) / 3.28;
        //let runway1k_num = (Math.log(treasury_runway) / Math.log(1 + 0.001920663)) / 3.28;
        //let runway2dot5k_num = (Math.log(treasury_runway) / Math.log(1 + 0.002685997)) / 3.28;
        //let runway5k_num = (Math.log(treasury_runway) / Math.log(1 + 0.003265339)) / 3.28;
        let nextEpochRebase_number = Number.parseFloat(rebase.toString()) / 100
        let runwayCurrent_num = (Math.log(treasury_runway) / Math.log(1 + nextEpochRebase_number)) / 3.28;

        //runway100 = BigDecimal.fromString(runway100_num.toString())
        //runway250 = BigDecimal.fromString(runway250_num.toString())
        //runway500 = BigDecimal.fromString(runway500_num.toString())
        //runway1k = BigDecimal.fromString(runway1k_num.toString())
        //runway2dot5k = BigDecimal.fromString(runway2dot5k_num.toString())
        //runway5k = BigDecimal.fromString(runway5k_num.toString())
        runwayCurrent = BigDecimal.fromString(runwayCurrent_num.toString())
    }

    return runwayCurrent
}


export function updateProtocolMetrics(transaction: Transaction): void {
    let pm = loadOrCreateProtocolMetric(transaction.timestamp);

    //Total Supply
    pm.totalSupply = getTotalSupply()

    //Circ Supply
    pm.klimaCirculatingSupply = getCriculatingSupply(transaction, pm.totalSupply)

    //sKlima Supply
    pm.sKlimaCirculatingSupply = getSklimaSupply(transaction)

    //KLIMA Price
    if (transaction.blockNumber.gt(BigInt.fromString(constants.KLIMA_BCT_PAIR_BLOCK))) {
        pm.klimaPrice = getKLIMAUSDRate()
    }

    //KLIMA Market Cap
    pm.marketCap = pm.klimaCirculatingSupply.times(pm.klimaPrice)

    //Total Value Locked
    pm.totalValueLocked = pm.sKlimaCirculatingSupply.times(pm.klimaPrice)

    // Update Treasury Assets
    let assetUpdates = updateTreasuryAssets(transaction)

    pm.assets = assetUpdates

    let valueUpdates = getMV_RFV(transaction, assetUpdates)
    pm.treasuryCarbon = valueUpdates[0]
    pm.treasuryRiskFreeValue = valueUpdates[1]
    pm.treasuryMarketValue = valueUpdates[2]

    // Rebase rewards, APY, rebase
    pm.nextDistributedKlima = getNextKLIMARebase(transaction)
    let apy_rebase = getAPY_Rebase(pm.sKlimaCirculatingSupply, pm.nextDistributedKlima)
    pm.currentAPY = apy_rebase[0]
    pm.nextEpochRebase = apy_rebase[1]

    //Runway
    pm.runwayCurrent = getRunway(pm.sKlimaCirculatingSupply, pm.treasuryRiskFreeValue, pm.nextEpochRebase)

    //Holders
    pm.holders = getHolderAux().value

    pm.save()

    //updateBondDiscounts(transaction)
}
