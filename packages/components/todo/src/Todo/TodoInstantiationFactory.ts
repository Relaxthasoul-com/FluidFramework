/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import {
    SharedCell,
} from "@prague/cell";
import { ComponentRuntime } from "@prague/component-runtime";
import { IComponent, IRequest } from "@prague/container-definitions";
import {
    CounterValueType,
    SharedMap,
} from "@prague/map";
import {
    IComponentContext,
    IComponentFactory,
    IComponentRuntime,
} from "@prague/runtime-definitions";
import { SharedString } from "@prague/sequence";
import { Todo } from "./index";

/**
 * This Factory provides the entry for creating a new Todo Component.
 *
 * Loading happens after creating a new component, after another person creates a new component, and
 * whenever the page loads.
 */
export class TodoInstantiationFactory implements IComponent, IComponentFactory {

    public static supportedInterfaces = ["IComponentFactory"];

    public query(id: string): any {
        return TodoInstantiationFactory.supportedInterfaces.indexOf(id) !== -1 ? this : undefined;
    }

    public list(): string[] {
        return TodoInstantiationFactory.supportedInterfaces;
    }

    /**
     * This is where we do component setup.
     */
    public async instantiateComponent(context: IComponentContext): Promise<IComponentRuntime> {
        // Create a map that we will pass in our Distributed Data Structure (DDS) registry.
        // All DDS' used in this component must be registered at this time.
        // This is because if we are loading from a snapshot we need to know everything that could
        // exist in that snapshot
        const dataTypes = new Map<string, any>();

        // Add Map DDS with Counter value type
        const mapValueTypes = [
            new CounterValueType(),
        ];
        const mapExtension = SharedMap.getFactory(mapValueTypes);
        dataTypes.set(mapExtension.type, mapExtension);

        // Add Cell DDS
        const cellExtension = SharedCell.getFactory();
        dataTypes.set(cellExtension.type, cellExtension);

        // Add SharedString DDS
        const sharedStringExtension = SharedString.getFactory();
        dataTypes.set(sharedStringExtension.type, sharedStringExtension);

        // Create a new runtime for our component
        // The runtime is what Fluid uses to create DDS' and route to your component
        const runtime = await ComponentRuntime.load(context, dataTypes);

        // Create a new instance of our component
        const counterNewP = Todo.load(runtime, context);

        // This will get called anytime a request({url: string}) call is made to the container
        // where the url is our unique component id.
        // We leverage this to return our instance of the component.
        runtime.registerRequestHandler(async (request: IRequest) => {
            const counter = await counterNewP;
            return counter.request(request);
        });

        return runtime;
    }
}
