const depositsHelper = require('./depositsHelper')
const fs = require('fs')
const contract = require('./contractHelper')
const toTaskInfo = require('./util/toTaskInfo')
const toSolutionInfo = require('./util/toSolutionInfo')
const midpoint = require('./util/midpoint')
const toIndices = require('./util/toIndices')
const waitForBlock = require('./util/waitForBlock')
const setupVM = require('./util/setupVM')
const assert = require('assert')

const merkleComputer = require("./merkle-computer")('./../wasm-client/ocaml-offchain/interpreter/wasm')

const contractsConfig = JSON.parse(fs.readFileSync(__dirname + "/contracts.json"))

function setup(httpProvider) {
    return (async () => {
	incentiveLayer = await contract(httpProvider, contractsConfig['incentiveLayer'])
	fileSystem = await contract(httpProvider, contractsConfig['fileSystem'])
	disputeResolutionLayer = await contract(httpProvider, contractsConfig['interactive'])
	return [incentiveLayer, fileSystem, disputeResolutionLayer]
    })()
}


let tasks = {}
let games = {}

module.exports = {
    init: async (web3, account, logger, mcFileSystem) => {
	logger.log({
	    level: 'info',
	    message: `Solver initialized`
	})

	let [incentiveLayer, fileSystem, disputeResolutionLayer] = await setup(web3.currentProvider)

	const taskCreatedEvent = incentiveLayer.TaskCreated()

	taskCreatedEvent.watch(async (err, result) => {
	    if (result) {
		let taskID = result.args.id
		let minDeposit = result.args.deposit.toNumber()		

		let taskInfo = toTaskInfo(await incentiveLayer.getTaskInfo.call(taskID))		

		let storageType = taskInfo.codeStorage
		let storageAddress = taskInfo.storageAddress
		let initTaskHash = taskInfo.initTaskHash

		let solutionInfo = toSolutionInfo(await incentiveLayer.solutionInfo.call(taskID))

		if (solutionInfo.solver == '0x0000000000000000000000000000000000000000') {
		    //TODO: Add more selection filters for solvers

		    let secret = Math.floor(Math.random() * Math.floor(100))

		    incentiveLayer.registerForTask(taskID, web3.utils.soliditySha3(secret))

		    tasks[taskID].secret = secret
		    
		}
	    }
	})

	const solverSelectedEvent = incentiveLayer.SolverSelected()
	solverSelectedEvent.watch(async (err, result) => {
	    if (result) {
		let taskID = result.args.taskID
		let solver = result.args.solver

		if (account.toLowerCase() == solver) {

		    if (!tasks[taskID]) {
			//TODO: Need to read secret from persistence or else task is lost
			let taskInfo = toTaskInfo(incentiveLayer.getTaskInfo.call(taskID))
			tasks[taskID].taskInfo = taskInfo
		    }

		    let solution, vm, interpreterArgs

		    await depositsHelper(web3, incentiveLayer, account, minDeposit)
		    logger.log({
			level: 'info',
			message: `Solving task ${taskID}`
		    })

		    let buf
		    if(storageType == merkleComputer.StorageType.BLOCKCHAIN) {

			let wasmCode = await fileSystem.getCode.call(storageAddress)

			buf = Buffer.from(wasmCode.substr(2), "hex")

			vm = await setupVM(
			    incentiveLayer,
			    merkleComputer,
			    taskID,
			    buf,
			    tasks[taskID].taskInfo.codeType,
			    false
			)
			
		    } else if(storageType == merkleComputer.StorageType.IPFS) {
			// download code file
			let codeIPFSHash = await fileSystem.getIPFSCode.call(storageAddress)
			
			let name = "task.wast"

			let codeBuf = (await mcFileSystem.download(codeIPFSHash, name)).content

			//download other files
			let fileIDs = await fileSystem.getFiles.call(storageAddress)

			let files = []

			if (fileIDs.length > 0) {
			    for(let i = 0; i < fileIDs.length; i++) {
				let fileID = fileIDs[i]
				let name = await fileSystem.getName.call(fileID)
				let ipfsHash = await fileSystem.getHash.call(fileID)
				let dataBuf = (await mcFileSystem.download(ipfsHash, name)).content
				files.push({
				    name: name,
				    dataBuf: dataBuf
				})				
			    }
			}
			
			vm = await setupVM(
			    incentiveLayer,
			    merkleComputer,
			    taskID,
			    codeBuf,
			    tasks[taskID].taskInfo.codeType,
			    false,
			    files
			)
			
		    }

		    assert(vm != undefined, "vm is undefined")
		    
		    interpreterArgs = []
		    solution = await vm.executeWasmTask(interpreterArgs)

		    //console.log(solution)

		    let realSolution = solution
		    let fakeSolution = web3.utils.soliditySha3(Math.random())
		    
		    try {

			if (Math.round(Math.random())) {
			    await incentiveLayer.commitSolution(taskID, realSolution, fakeSolution, {from: solver})
			    tasks[taskID].realSolution = 0
			} else {
			    await incentiveLayer.commitSolution(taskID, fakeSolution, realSolution, {from: solver})
			    tasks[taskID].realSolution = 1
			}
			
			logger.log({
			    level: 'info',
			    message: `Submitted solution for task ${taskID} successfully`
			})

			tasks[taskID]["solution"] = solution
			tasks[taskID]["vm"] = vm
			tasks[taskID]["interpreterArgs"] = interpreterArgs
						
		    } catch(e) {
			//TODO: Add logging unsuccessful submission attempt
			console.log(e)
		    }
		}
		
		
	    }
	})

	const taskStateChangedEvent = incentiveLayer.TaskStateChange()
	taskStateChangedEvent.watch(async (err, result) => {
	    if (result) {
		let taskID = result.args.taskID.toNumber()
		if (tasks[taskID] && result.args.state.toNumber() == 4) {

		    if(tasks[taskID].realSolution == 0) {
			await incentiveLayer.revealSolution(taskID, true, tasks[taskID].secret)
		    } else {
			await incentiveLayer.revealSolution(taskID, false, tasks[taskID].secret)
		    }
		    
		}
	    }
	})

	const startChallengeEvent = disputeResolutionLayer.StartChallenge()

	startChallengeEvent.watch(async (err, result) => {
	    if (result) {
		let solver = result.args.p
		let gameID = result.args.uniq
		if (solver.toLowerCase() == account.toLowerCase()) {

		    let taskID = (await disputeResolutionLayer.getTask.call(gameID)).toNumber()

		    logger.log({
			level: 'info',
			message: `Solution to task ${taskID} has been challenged`
		    })
		    
		    
		    //Initialize verification game
		    let vm = tasks[taskID].vm

		    let solution = tasks[taskID].solution

		    let initWasm = await vm.initializeWasmTask(tasks[taskID].interpreterArgs)

		    let lowStep = 0
		    let highStep = solution.steps + 1

		    games[gameID] = {
			lowStep: lowStep,
			highStep: highStep,
			taskID: taskID
		    }		    
		    
		    await disputeResolutionLayer.initialize(
			gameID,
			merkleComputer.getRoots(initWasm.vm),
			merkleComputer.getPointers(initWasm.vm),
			solution.steps + 1,
			merkleComputer.getRoots(solution.vm),
			merkleComputer.getPointers(solution.vm),
			{
			    from: account,
			    gas: 1000000
			}
		    )		    

		    logger.log({
			level: 'info',
			message: `Game ${gameID} has been initialized`
		    })

		    let indices = toIndices(await disputeResolutionLayer.getIndices.call(gameID))

		    //Post response to implied midpoint query
		    let stepNumber = midpoint(indices.low, indices.high)

		    let stateHash = await tasks[taskID].vm.getLocation(stepNumber, tasks[taskID].interpreterArgs)

		    await disputeResolutionLayer.report(gameID, indices.low, indices.high, [stateHash], {from: account})

		    logger.log({
			level: 'info',
			message: `Reported state hash for step: ${stepNumber} game: ${gameID} low: ${indices.low} high: ${indices.high}`
		    })

		    let currentBlockNumber = await web3.eth.getBlockNumber()
		    waitForBlock(web3, currentBlockNumber + 105, async () => {
			if(await disputeResolutionLayer.gameOver.call(gameID)) {
			    await disputeResolutionLayer.gameOver(gameID, {from: account})
			}
		    })
		    
		}
	    }
	})

	const queriedEvent = disputeResolutionLayer.Queried()

	queriedEvent.watch(async (err, result) => {
	    if (result) {
		let gameID = result.args.id
		let lowStep = result.args.idx1.toNumber()
		let highStep = result.args.idx2.toNumber()

		if(games[gameID]) {
		    
		    let taskID = games[gameID].taskID

		    logger.log({
			level: 'info',
			message: `Received query Task: ${taskID} Game: ${gameID}`
		    })
		    
		    if(lowStep + 1 != highStep) {
			let stepNumber = midpoint(lowStep, highStep)

			let stateHash = await tasks[taskID].vm.getLocation(stepNumber, tasks[taskID].interpreterArgs)

			await disputeResolutionLayer.report(gameID, lowStep, highStep, [stateHash], {from: account})
			
		    } else {
			//Final step -> post phases
			
			let lowStepState = await disputeResolutionLayer.getStateAt.call(gameID, lowStep)
			let highStepState = await disputeResolutionLayer.getStateAt.call(gameID, highStep)

			let states = (await tasks[taskID].vm.getStep(lowStep, tasks[taskID].interpreterArgs)).states

			await disputeResolutionLayer.postPhases(
			    gameID,
			    lowStep,
			    states,
			    {
				from: account,
				gas: 400000
			    }
			)

			logger.log({
			    level: 'info',
			    message: `Phases have been posted for game ${gameID}`
			})
			
		    }
		    
		    let currentBlockNumber = await web3.eth.getBlockNumber()	    
		    waitForBlock(web3, currentBlockNumber + 105, async () => {
			if(await disputeResolutionLayer.gameOver.call(gameID)) {
			    await disputeResolutionLayer.gameOver(gameID, {from: account})
			}
		    })
		    
		 }
	     }
	})

	const selectedPhaseEvent = disputeResolutionLayer.SelectedPhase()

	selectedPhaseEvent.watch(async (err, result) => {
	    if (result) {
		let gameID = result.args.id
		if (games[gameID]) {
		    let taskID = games[gameID].taskID
		    
		    let lowStep = result.args.idx1.toNumber()
		    let phase = result.args.phase.toNumber()

		    logger.log({
			level: 'info',
			message: `Phase ${phase} for game  ${gameID}`
		    })
		    

		    let stepResults = await tasks[taskID].vm.getStep(lowStep, tasks[taskID].interpreterArgs)

		    let phaseStep = merkleComputer.phaseTable[phase]

		    let proof = stepResults[phaseStep]

    		    let merkle = proof.location || []

    		    let merkle2 = []

		    if (proof.merkle) {
			merkle = proof.merkle.list || proof.merkle.list1 || []
			merkle2 = proof.merkle.list2 || []
		    }

    		    let m = proof.machine || {reg1:0, reg2:0, reg3:0, ireg:0, vm:"0x00", op:"0x00"}
		    let vm
		    if (typeof proof.vm != "object") {
			vm = {
			    code: "0x00",
			    stack:"0x00",
			    call_stack:"0x00",
			    calltable:"0x00",
			    globals : "0x00",
			    memory:"0x00",
			    calltypes:"0x00",
			    input_size:"0x00",
			    input_name:"0x00",
			    input_data:"0x00",
			    pc:0,
			    stack_ptr:0,
			    call_ptr:0,
			    memsize:0
			}
		    } else { vm = proof.vm }

		    if (phase == 6 && parseInt(m.op.substr(-12, 2), 16) == 16) {
			disputeResolutionLayer.callCustomJudge(
			    gameID,
			    lowStep,
			    m.op,
			    [m.reg1, m.reg2, m.reg3, m.ireg],
			    proof.merkle.result_state,
			    proof.merkle.result_size,
			    proof.merkle.list,
			    merkleComputer.getRoots(vm),
			    merkleComputer.getPointers(vm),
			    {from: account, gas: 500000}
			)

			//TODO
			//merkleComputer.getLeaf(proof.merkle.list, proof.merkle.location)
			//merkleComputer.storeHash(hash, proof.merkle.data)
		    } else {
    			await disputeResolutionLayer.callJudge(
    			    gameID,
    			    lowStep,
    			    phase,
    			    merkle,
    			    merkle2,
    			    m.vm,
    			    m.op,
    			    [m.reg1, m.reg2, m.reg3, m.ireg],
    			    merkleComputer.getRoots(vm),
    			    merkleComputer.getPointers(vm),
    			    {from: account, gas: 500000}
			)			
		    }
		    
		    logger.log({
			level: 'info',
			message: `Judge called for game ${gameID}`
		    })
		    
		}
	    }
	})

	return () => {
	    try {
		let empty = data => { }
		taskPostedEvent.stopWatching(empty)
		startChallengeEvent.stopWatching(empty)
		queriedEvent.stopWatching(empty)
		selectedPhaseEvent.stopWatching(empty)
	    } catch(e) {
	    }
	}
    }
}
