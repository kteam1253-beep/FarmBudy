CompleteContractEvent = {}
local CompleteContractEvent_mt = Class(CompleteContractEvent, Event)

InitEventClass(CompleteContractEvent, "CompleteContractEvent")

local function getSenderFarmId(connection, fallback)
  -- Try the most common places FS exposes farmId
  if connection ~= nil then
    if connection.getFarmId ~= nil then
      local ok, fid = pcall(function() return connection:getFarmId() end)
      if ok and fid ~= nil then return fid end
    end
    if connection.player ~= nil and connection.player.farmId ~= nil then
      return connection.player.farmId
    end
  end
  return fallback
end


function CompleteContractEvent.emptyNew()
  local self = Event.new(CompleteContractEvent_mt)
  return self
end

function CompleteContractEvent.new(contractId, farmId)
  local self = CompleteContractEvent.emptyNew()
  self.farmId = farmId
  self.contractId = contractId
  return self
end

function CompleteContractEvent:writeStream(streamId, connection)
  streamWriteInt32(streamId, self.farmId)
  streamWriteInt32(streamId, self.contractId)
end

function CompleteContractEvent:readStream(streamId, connection)
  self.farmId = streamReadInt32(streamId)
  self.contractId = streamReadInt32(streamId)
  self:run(connection)
end

function CompleteContractEvent:run(connection)
  local senderFarmId = getSenderFarmId(connection, self.farmId)
  if not connection:getIsServer() then
    g_server:broadcastEvent(CompleteContractEvent.new(self.contractId, senderFarmId))
  end

  local contractManager = g_currentMission.customContracts.ContractManager
  contractManager:handleCompleteRequest(senderFarmId, self.contractId)
end
