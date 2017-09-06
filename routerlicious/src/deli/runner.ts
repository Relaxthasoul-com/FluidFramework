import { queue } from "async";
import * as _ from "lodash";
import { Collection } from "mongodb";
import * as winston from "winston";
import * as core from "../core";
import * as shared from "../shared";
import * as utils from "../utils";
import { TakeANumber } from "./takeANumber";

export class DeliRunner {
    private deferred: shared.Deferred<void>;
    private checkpointTimer: any;
    private q: AsyncQueue<string>;

    constructor(
        private producer: utils.kafkaProducer.IProducer,
        private consumer: utils.kafkaConsumer.IConsumer,
        private objectsCollection: Collection,
        private groupId: string,
        private receiveTopic: string,
        private checkpointBatchSize: number,
        private checkpointTimeIntervalMsec: number) {
    }

    public start(): Promise<void> {
        this.deferred = new shared.Deferred<void>();
        const dispensers: { [key: string]: TakeANumber } = {};
        const partitionManager = new core.PartitionManager(
            this.groupId,
            this.receiveTopic,
            this.consumer,
            this.checkpointBatchSize,
            this.checkpointTimeIntervalMsec,
        );

        this.consumer.on("data", (message) => {
            this.q.push(message);
        });

        this.consumer.on("error", (err) => {
            this.consumer.close();
            this.deferred.reject(err);
        });

        let ticketQueue: {[id: string]: Promise<void> } = {};

        const throughput = new utils.ThroughputCounter(winston.info);

        winston.info("Waiting for messages");
        this.q = queue((message: any, callback) => {
            throughput.produce();
            this.processMessage(
                message,
                dispensers,
                ticketQueue,
                partitionManager,
                this.producer,
                this.objectsCollection);
            throughput.acknolwedge();

            // Periodically checkpoint to mongo and checkpoints offset back to kafka.
            // Ideally there should be a better strategy to figure out when to checkpoint.
            if (message.offset % this.checkpointBatchSize === 0) {
                const pendingDispensers = _.keys(ticketQueue).map((key) => dispensers[key]);
                const pendingTickets = _.values(ticketQueue);
                ticketQueue = {};
                this.checkpoint(partitionManager, pendingDispensers, pendingTickets).catch((error) => {
                    this.deferred.reject(error);
                });
            }
            callback();
        }, 1);

        return this.deferred.promise;
    }

    /**
     * Signals to stop the service
     */
    public stop(): Promise<void> {
        winston.info("Stop requested");

        // stop listening for new updates
        this.consumer.pause();

        // Drain the queue of any pending operations
        const drainedP = new Promise<void>((resolve, reject) => {
            // If not entries in the queue we can exit immediatley
            if (this.q.length() === 0) {
                winston.info("No pending work exiting early");
                return resolve();
            }

            // Wait until the queue is drained
            winston.info("Waiting for queue to drain");
            this.q.drain = () => {
                winston.info("Drained");
                resolve();
            };
        });

        // Mark ourselves done once the queue is cleaned
        drainedP.then(() => {
            // TODO perform one last checkpoint here
            this.deferred.resolve();
        });

        return this.deferred.promise;
    }

    private processMessage(
        message: any,
        dispensers: { [key: string]: TakeANumber },
        ticketQueue: {[id: string]: Promise<void> },
        partitionManager: core.PartitionManager,
        producer: utils.kafkaProducer.IProducer,
        objectsCollection: Collection) {

        const baseMessage = JSON.parse(message.value.toString("utf8")) as core.IMessage;
        if (baseMessage.type === core.UpdateReferenceSequenceNumberType ||
            baseMessage.type === core.RawOperationType) {

            const objectMessage = JSON.parse(message.value.toString("utf8")) as core.IObjectMessage;
            const documentId = objectMessage.documentId;

            // Go grab the takeANumber machine for the objectId and mark it as dirty.
            // Store it in the partition map. We need to add an eviction strategy here.
            if (!(documentId in dispensers)) {
                dispensers[documentId] = new TakeANumber(documentId, objectsCollection, producer);
                winston.info(`New document ${documentId}`);
            }
            const dispenser = dispensers[documentId];

            // Either ticket the message or update the sequence number depending on the message type
            const ticketP = dispenser.ticket(message);
            ticketQueue[documentId] = ticketP;
        }

        // Update partition manager entry.
        partitionManager.update(message.partition, message.offset);
    }

    private async checkpoint(
        partitionManager: core.PartitionManager,
        dispensers: TakeANumber[],
        pendingTickets: Array<Promise<void>>) {

        // Clear timer since we will checkpoint now.
        if (this.checkpointTimer) {
            clearTimeout(this.checkpointTimer);
        }

        if (pendingTickets.length === 0 && dispensers.length === 0) {
            return;
        }

        // Ticket all messages and empty the queue.
        await Promise.all(pendingTickets);
        pendingTickets = [];

        // Checkpoint to mongo and empty the dispensers.
        let checkpointQueue = dispensers.map((dispenser) => dispenser.checkpoint());
        await Promise.all(checkpointQueue);
        dispensers = [];

        // Finally call kafka checkpointing.
        partitionManager.checkPoint();

        // Set up next cycle.
        this.checkpointTimer = setTimeout(() => {
            this.checkpoint(partitionManager, dispensers, pendingTickets);
        }, this.checkpointTimeIntervalMsec);
    }
}
