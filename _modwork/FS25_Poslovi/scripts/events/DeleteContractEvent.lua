DeleteContractEvent = {}
local DeleteContractEvent_mt = Class(DeleteContractEvent, Event)

InitEventClass(DeleteContractEvent, "DeleteContractEvent")

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


function DeleteContractEvent.emptyNew()
  local self = Event.new(DeleteContractEvent_mt)
  return self
end

function DeleteContractEvent.new(contractId, farmId)
  local self = DeleteContractEvent.emptyNew()
  self.contractId = contractId
  self.farmId = farmId
  return self
end

function DeleteContractEvent:writeStream(streamId, connection)
  streamWriteInt32(streamId, self.contractId)
  streamWriteInt32(streamId, self.farmId)
end

function DeleteContractEvent:readStream(streamId, connection)
  self.contractId = streamReadInt32(streamId)
  self.farmId = streamReadInt32(streamId)
  self:run(connection)
end

function DeleteContractEvent:run(connection)
  local senderFarmId = getSenderFarmId(connection, self.farmId)
  if not connection:getIsServer() then
    g_server:broadcastEvent(DeleteContractEvent.new(self.contractId, senderFarmId))
  end

  local contractManager = g_currentMission.customContracts.ContractManager
  contractManager:handleDeleteRequest(senderFarmId, self.contractId)
end
