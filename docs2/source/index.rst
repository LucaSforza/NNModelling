NNModelling Documentation
=========================

NNModelling is a browser-owned visual DSL for package-native neural networks.
The editor's ``DiagramCore`` owns the graph and package type inference runs
locally in isolated Lua runtimes.

The supported workflow is:

.. code-block:: text

   package definitions -> DiagramCore -> authenticated package bundle
   -> FastAPI -> Podman/Docker worker -> portable prediction wheel

The MCP server is a thin browser proxy. It does not compile legacy graph
formats or execute Python on the host.

.. toctree::
   :maxdepth: 2

   user_guide
   training_user_guide
   training_admin_guide
   architecture
   stereotypes
   python_api
   typescript_api
   type_system
   examples
license
